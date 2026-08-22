import { describe, expect, it } from 'bun:test'

import { executeDurable, requestCancellation, SagaError } from '@bayraak/sagaflow'

import { defineWorkflow } from '../src/define.js'
import { defineStep } from '../src/step.js'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

/*
 * Finding F1, from formal/RESULTS.md, driven as a test.
 *
 * A cancellation is noticed, the run is closed `cancelled`, and the instance then crashes in the
 * window between the finish batch committing and the platform checkpointing `finish-run`. The
 * re-invocation replays the memoised steps — and a memoised step never calls `recordStep`, so it
 * never re-reads the cancellation flag. The body walks further than the invocation that closed
 * the run did: steps that never ran execute for real, against a run already recorded as fully
 * undone, and a second announcement lands under a different id.
 *
 * TLC found this at eleven states. It is here so it cannot come back.
 */
const cancelledThenReinvoked = async (): Promise<{
  harness: ReturnType<typeof createTestRuntime>
  ran: string[]
  thrown: unknown
}> => {
  const harness = createTestRuntime()
  const ran: string[] = []

  const first = defineStep<TestRuntime, { mark: string }, { seen: string }>('first', {
    run: async (input, ctx) => {
      ran.push('first')
      await requestCancellation({ journal: ctx.journal, tenantId: ctx.tenantId, runId: ctx.runId })

      return { seen: input.mark }
    },
    undo: async () => {
      ran.push('undo:first')
    },
  })

  // The step the first walk never reached. On a replay it must never reach it either.
  const second = defineStep<TestRuntime, { mark: string }, { seen: string }>('second', {
    run: async (input) => {
      ran.push('second')

      return { seen: input.mark }
    },
  })

  const workflow = defineWorkflow(
    { name: 'formal.f1', input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf) => {
      await wf.step(first, input)
      await wf.step(second, input)
    },
  )

  const runId = await harness.journal.insertRun({
    tenantId: 'tenant_local',
    name: 'formal.f1',
    execution: 'durable',
    idempotencyKey: null,
    input: { mark: 'x' },
  })

  // Everything is checkpointed except the finish: the batch committed, the platform never
  // recorded that it had.
  const platform = createCachingPrimitive({ neverCache: ['finish-run', 'emit-events'] })

  await executeDurable(workflow, { runId, input: { mark: 'x' } }, harness.ctx, platform.primitive())
    .then(() => undefined)
    .catch(() => undefined)

  const thrown = await executeDurable(
    workflow,
    { runId, input: { mark: 'x' } },
    harness.ctx,
    platform.primitive(),
  ).catch((error: unknown) => error)

  return { harness, ran, thrown }
}

describe('F1 — a run re-invoked after it was closed', () => {
  it('runs nothing at all', async () => {
    const { ran } = await cancelledThenReinvoked()

    expect(ran).toEqual(['first', 'undo:first'])
  })

  it('leaves the run exactly as the invocation that closed it left it', async () => {
    const { harness } = await cancelledThenReinvoked()

    expect(harness.runs[0]?.status).toBe('cancelled')
    expect(harness.finishes).toHaveLength(1)
  })

  it('announces the closure once', async () => {
    const { harness } = await cancelledThenReinvoked()

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
  })

  it('tells the caller the run had already ended', async () => {
    const { thrown, harness } = await cancelledThenReinvoked()

    expect(thrown).toBeInstanceOf(SagaError)
    expect((thrown as SagaError).outcome).toBe('cancelled')
    expect((thrown as SagaError).runId).toBe(harness.runs[0]?.id as string)
  })
})

/*
 * The second half of F1, and independent of the guard: the lifecycle announcement's id was a
 * function of how far the walk got, not of the run. A longer walk minted it at a higher ordinal,
 * which is a different envelope id, which `on conflict (id) do nothing` cannot recognise as a
 * repeat. One run can only ever close once, so its closure has one id.
 */
describe('F1 — the announcement is identified by the run, not by the walk', () => {
  const emitting = defineStep<TestRuntime, { mark: string }, { seen: string }>('emit-one', {
    run: async (input, ctx) => {
      ctx.emit('invoice.voided', { invoiceId: input.mark })

      return { seen: input.mark }
    },
  })

  it('names a completed run’s announcement after the run', async () => {
    const harness = createTestRuntime()
    const workflow = defineWorkflow(
      { name: 'formal.f1-completed', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf) => {
        await wf.step(emitting, input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.outbox.map((event) => [event.type, event.id])).toEqual([
      ['invoice.voided', 'run_1:0'],
      ['workflow.completed', 'run_1:completed'],
    ])
  })

  it('names an undone run’s announcement after the run', async () => {
    const harness = createTestRuntime()
    const boom = defineStep<TestRuntime, { mark: string }, never>('boom', {
      run: async () => {
        throw new Error('no')
      },
    })
    const workflow = defineWorkflow(
      { name: 'formal.f1-compensated', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf) => {
        await wf.step(emitting, input)
        await wf.step(boom, input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.outbox.map((event) => [event.type, event.id])).toEqual([
      ['workflow.compensated', 'run_1:compensated'],
    ])
  })

  // The id no longer moves with the walk, so however far a body gets, the closure is one row.
  it('cannot mint a second announcement under a second id', async () => {
    const harness = createTestRuntime()
    const workflow = defineWorkflow(
      { name: 'formal.f1-twice', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf) => {
        await wf.step(emitting, input)
      },
    )

    const platform = createCachingPrimitive({ neverCache: ['finish-run', 'emit-events'] })
    for (let invocation = 0; invocation < 2; invocation += 1) {
      await executeDurable(
        workflow,
        { runId: 'run_fixed', input: { mark: 'x' } },
        harness.ctx,
        platform.primitive(),
      ).catch(() => undefined)
    }

    expect(harness.outbox.filter((event) => event.type === 'workflow.completed')).toHaveLength(1)
    expect(harness.outbox.map((event) => event.id)).toEqual(['run_fixed:0', 'run_fixed:completed'])
  })
})
