import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import {
  executeDurable,
  SagaError,
  type DurableWorkflowHandle,
  type WorkflowHandle,
} from '../src/index.js'
import { defineStep } from '../src/step.js'
import { passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, firstFinish, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

const writeStep = (options: { fails?: boolean } = {}) =>
  defineStep<TestRuntime, { mark: string }, { seen: string }>('write', {
    run: async (input, ctx) => {
      ctx.emit('invoice.issued', { invoiceId: input.mark, total: 1 })
      if (options.fails) throw new Error('write refused')

      return { seen: input.mark }
    },
    undo: async () => undefined,
  })

const savingWorkflow = (options: { fails?: boolean } = {}) =>
  defineWorkflow(
    { name: 'test.outbox-save', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      const written = await wf.step(writeStep(options), input)
      wf.emit('invoice.voided', { invoiceId: input.mark })

      return { finished: written.seen }
    },
  )

const durableSavingWorkflow = defineWorkflow(
  { name: 'test.outbox-durable', input: markInput, execution: 'durable' },
  async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
    const written = await wf.step(writeStep(), input)
    wf.emit('invoice.voided', { invoiceId: input.mark })

    return { finished: written.seen }
  },
)

describe('a completed run and its events are one fact', () => {
  it('hands the held events to the finish', async () => {
    const harness = createTestRuntime()

    await savingWorkflow().run({ input: { mark: 'OUTBOX-1' }, ctx: harness.ctx })

    expect(firstFinish(harness.finishes).events.map((event) => event.type)).toEqual([
      'invoice.issued',
      'invoice.voided',
      'workflow.completed',
    ])
  })

  it('closes the run in the same write that carries them', async () => {
    const harness = createTestRuntime()

    await savingWorkflow().run({ input: { mark: 'OUTBOX-2' }, ctx: harness.ctx })

    expect(harness.finishes).toHaveLength(1)
    expect(firstFinish(harness.finishes).status).toBe('completed')
  })

  it('gives every envelope its own id', async () => {
    const harness = createTestRuntime()

    await savingWorkflow().run({ input: { mark: 'OUTBOX-3' }, ctx: harness.ctx })

    const ids = firstFinish(harness.finishes).events.map((event) => event.id)

    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('hands over nothing the body emitted for a compensated run', async () => {
    const harness = createTestRuntime()

    await savingWorkflow({ fails: true })
      .run({ input: { mark: 'OUTBOX-4' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(firstFinish(harness.finishes).status).toBe('compensated')
    expect(
      firstFinish(harness.finishes).events.filter((event) => event.type === 'invoice.issued'),
    ).toEqual([])
    expect(harness.sent).toEqual([])
  })

  it("carries a durable run's events too", async () => {
    const harness = createTestRuntime()

    await executeDurable(
      durableSavingWorkflow,
      { runId: 'run_durable', input: { mark: 'OUTBOX-11' } },
      harness.ctx,
      passThroughPrimitive(),
    )

    expect(firstFinish(harness.finishes).events.map((event) => event.type)).toEqual([
      'invoice.issued',
      'invoice.voided',
      'workflow.completed',
    ])
  })
})

describe('the drain', () => {
  it('sends one batch for the whole run', async () => {
    const harness = createTestRuntime()

    await savingWorkflow().run({ input: { mark: 'OUTBOX-5' }, ctx: harness.ctx })

    expect(harness.batches).toHaveLength(1)
    expect(harness.batches[0]?.map((message) => message.type)).toEqual([
      'invoice.issued',
      'invoice.voided',
      'workflow.completed',
    ])
  })

  it('stamps what it sent', async () => {
    const harness = createTestRuntime()

    await savingWorkflow().run({ input: { mark: 'OUTBOX-6' }, ctx: harness.ctx })

    expect(harness.dispatched).toEqual(harness.sent.map((message) => message.id))
  })

  it('runs after the run is closed', async () => {
    const harness = createTestRuntime()
    const seen: string[] = []
    const journal = harness.ctx.journal

    const watched: TestRuntime = {
      ...harness.ctx,
      journal: {
        ...journal,
        finishRun: async (params) => {
          seen.push(`finish:${params.status}`)

          return journal.finishRun(params)
        },
      },
      events: {
        sendBatch: async (messages) => {
          seen.push(`send:${messages.length}`)
        },
      },
    }

    await savingWorkflow().run({ input: { mark: 'OUTBOX-7' }, ctx: watched })

    expect(seen).toEqual(['finish:completed', 'send:3'])
  })
})

// The whole point of writing the events down before sending them: the caller asked for a
// mutation, the mutation committed, and a queue that cannot be reached is not the caller's
// problem. Without an outbox the send throws and the caller is told its committed work failed.
describe('a sink that cannot be reached', () => {
  it('does not fail the caller', async () => {
    const harness = createTestRuntime({ sinkRefuses: true })

    const result = await savingWorkflow().run({ input: { mark: 'OUTBOX-8' }, ctx: harness.ctx })

    expect(result.deduplicated).toBe(false)
    expect(!result.deduplicated && result.output).toEqual({ finished: 'OUTBOX-8' })
  })

  it('still closes the run as completed', async () => {
    const harness = createTestRuntime({ sinkRefuses: true })

    await savingWorkflow().run({ input: { mark: 'OUTBOX-9' }, ctx: harness.ctx })

    expect(harness.runs[0]?.status).toBe('completed')
  })

  it('leaves the events in the outbox', async () => {
    const harness = createTestRuntime({ sinkRefuses: true })

    await savingWorkflow().run({ input: { mark: 'OUTBOX-10' }, ctx: harness.ctx })

    expect(harness.outbox.map((event) => event.type)).toEqual([
      'invoice.issued',
      'invoice.voided',
      'workflow.completed',
    ])
    expect(harness.dispatched).toEqual([])
  })

  it('does not fail a durable instance', async () => {
    const harness = createTestRuntime({ sinkRefuses: true })

    const result = await executeDurable(
      durableSavingWorkflow,
      { runId: 'run_durable_dead', input: { mark: 'OUTBOX-12' } },
      harness.ctx,
      passThroughPrimitive(),
    ).catch((error: unknown) => error)

    expect(result).not.toBeInstanceOf(SagaError)
    expect(result).toEqual({ finished: 'OUTBOX-12' })
    expect(harness.outbox).toHaveLength(3)
  })
})
