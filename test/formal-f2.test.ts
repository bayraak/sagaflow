import { describe, expect, it } from 'bun:test'

import { executeDurable, SagaError } from 'sagaflow-js'

import { defineWorkflow } from '../src/define.js'
import { defineStep } from '../src/step.js'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

/*
 * Finding F2, from formal/RESULTS.md, driven as a test.
 *
 * Two rules that are each right on their own composed badly. Every undo is attempted even when
 * an earlier one refuses, so a step is not left standing because its neighbour could not be
 * reversed. And a refused undo is not checkpointed, so a re-invocation tries it again. Together
 * they let the retry of an early-in-reverse-order undo land AFTER undos that already succeeded,
 * and the run was nevertheless written down as `compensated` — which reads as "unwound in
 * reverse start order" and was not.
 *
 * The counterexample: three steps, the third fails, the undo of the second refuses, the undo of
 * the first succeeds, the instance crashes before the finish, and the re-invocation retries the
 * refused undo and gets it. Undo order across the two invocations: first, then second. Forward.
 */
const refusedThenReinvoked = async (): Promise<{
  harness: ReturnType<typeof createTestRuntime>
  ran: string[]
  thrown: unknown
}> => {
  const harness = createTestRuntime()
  const ran: string[] = []
  let refusals = 0

  const one = defineStep<never, { mark: string }, { seen: string }>('one', {
    run: async (input) => {
      ran.push('one')

      return { seen: input.mark }
    },
    undo: async () => {
      ran.push('undo:one')
    },
  })

  const two = defineStep<never, { mark: string }, { seen: string }>('two', {
    run: async (input) => {
      ran.push('two')

      return { seen: input.mark }
    },
    // Refuses the first time and would succeed the second. A flaky undo is the ordinary case:
    // the downstream service was down for a minute, and then it was not.
    undo: async () => {
      refusals += 1
      if (refusals === 1) {
        ran.push('undo:two refused')
        throw new Error('the refund service is down')
      }
      ran.push('undo:two')
    },
  })

  const three = defineStep<never, { mark: string }, { seen: string }>('three', {
    run: async () => {
      ran.push('three')
      throw new Error('three cannot be done')
    },
  })

  const workflow = defineWorkflow(
    { name: 'formal.f2', input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf) => {
      await wf.step(one, input)
      await wf.step(two, input)
      await wf.step(three, input)
    },
  )

  const runId = await harness.journal.insertRun({
    tenantId: 'tenant_local',
    name: 'formal.f2',
    execution: 'durable',
    idempotencyKey: null,
    input: { mark: 'x' },
  })

  // The crash of the counterexample: the unwind is done, and the instance dies on the way
  // into the write that would have closed the run. The run row is still `running`.
  const platform = createCachingPrimitive({ crashOnce: ['finish-run'] })

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

describe('F2 — an undo that was recorded as refused', () => {
  it('is not attempted again by a later invocation', async () => {
    const { ran } = await refusedThenReinvoked()

    expect(ran.filter((entry) => entry.startsWith('undo:two'))).toEqual(['undo:two refused'])
  })

  it('never lets an undo succeed after one that started later already did', async () => {
    const { ran } = await refusedThenReinvoked()

    expect(ran.filter((entry) => entry === 'undo:one' || entry === 'undo:two')).toEqual([
      'undo:one',
    ])
  })

  it('closes the run failed, because something really was left standing', async () => {
    const { harness } = await refusedThenReinvoked()

    expect(harness.runs[0]?.status).toBe('failed')
  })

  it('names the step whose undo was refused', async () => {
    const { thrown } = await refusedThenReinvoked()

    expect(thrown).toBeInstanceOf(SagaError)
    expect((thrown as SagaError).outcome).toBe('failed')
    expect((thrown as SagaError).failedCompensations).toEqual(['two'])
  })
})
