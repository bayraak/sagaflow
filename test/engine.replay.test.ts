import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { step, executeDurable, type WorkflowHandle } from '../src/index.js'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

const issuingStep = step<TestRuntime, { mark: string }, { seen: string }>('issue', {
  run: async (input, ctx) => {
    ctx.invocations.push('invoke:issue')
    ctx.emit('invoice.issued', { invoiceId: input.mark, total: 10 })

    return { seen: input.mark }
  },
  undo: async () => undefined,
})

const replayable = defineWorkflow(
  { name: 'test.replayable', input: markInput, execution: 'durable' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
    const issued = await wf.step(issuingStep, input)
    wf.emit('invoice.voided', { invoiceId: input.mark })

    return { finished: issued.seen }
  },
)

const driveTwice = async (
  harness: ReturnType<typeof createTestRuntime>,
  options: { neverCache?: string[] } = {},
) => {
  const platform = createCachingPrimitive(options)

  for (let invocation = 0; invocation < 2; invocation += 1) {
    await executeDurable(
      replayable,
      { runId: 'run_replayed', input: { mark: 'INV-9' } },
      harness.ctx,
      platform.primitive(),
    )
  }

  return platform
}

// A durable instance can be invoked more than once for the same run — a retry after a crash,
// a resume that lost its acknowledgement. The body runs again from the top; the steps come
// back from the journal. Everything the engine does AFTER the body must survive that.
describe('a durable run re-invoked for the same run id', () => {
  it('does not do the work again', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    expect(harness.invocations).toEqual(['invoke:issue'])
  })

  it('closes the run once, because the finish is a step like any other', async () => {
    const harness = createTestRuntime()

    const platform = await driveTwice(harness)

    expect(platform.calls.filter((name) => name === 'finish-run')).toHaveLength(2)
    expect(platform.executed.filter((name) => name === 'finish-run')).toHaveLength(1)
    expect(harness.finishes).toHaveLength(1)
  })

  it('writes one set of outbox rows', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    expect(harness.outbox.map((event) => event.type)).toEqual([
      'invoice.issued',
      'invoice.voided',
      'workflow.completed',
    ])
  })

  it('gives an envelope the same id every time the run produces it', async () => {
    const first = createTestRuntime()
    const second = createTestRuntime()

    await driveTwice(first)
    await driveTwice(second)

    expect(first.outbox.map((event) => event.id)).toEqual(second.outbox.map((event) => event.id))
    expect(first.outbox.map((event) => event.id)).toEqual([
      'run_replayed:0',
      'run_replayed:1',
      'run_replayed:2',
    ])
  })
})

// The window that actually hurts: the last step was recorded, the finish was not, and the
// platform invokes the body again. The finish runs a second time — and has to write exactly
// what the first one would have written, or the consumer sees a second copy of every event
// under ids it has never seen before.
describe('a durable run re-invoked after its finish was lost', () => {
  const driveTwiceWithLostFinish = async (harness: ReturnType<typeof createTestRuntime>) =>
    driveTwice(harness, { neverCache: ['finish-run', 'emit-events'] })

  it('closes the run a second time', async () => {
    const harness = createTestRuntime()

    await driveTwiceWithLostFinish(harness)

    expect(harness.finishes).toHaveLength(2)
  })

  // The events a STEP emitted are part of what that step produced, so they come back with its
  // memoised result. A replayed step whose body never ran still contributes what it announced.
  it('still contributes the event its replayed step emitted', async () => {
    const harness = createTestRuntime()

    await driveTwiceWithLostFinish(harness)

    expect(harness.invocations).toEqual(['invoke:issue'])
    expect(harness.finishes.map((finish) => finish.events.map((event) => event.type))).toEqual([
      ['invoice.issued', 'invoice.voided', 'workflow.completed'],
      ['invoice.issued', 'invoice.voided', 'workflow.completed'],
    ])
  })

  it('writes the same envelope ids both times', async () => {
    const harness = createTestRuntime()

    await driveTwiceWithLostFinish(harness)

    const [first, second] = harness.finishes.map((finish) => finish.events.map((event) => event.id))

    expect(first).toEqual(['run_replayed:0', 'run_replayed:1', 'run_replayed:2'])
    expect(second).toEqual(first)
  })

  // Which is the whole point: the second write lands on rows that already exist, so the
  // consumer is never handed a second copy it cannot recognise.
  it('leaves one set of rows in the outbox', async () => {
    const harness = createTestRuntime()

    await driveTwiceWithLostFinish(harness)

    expect(harness.outbox.map((event) => event.id)).toEqual([
      'run_replayed:0',
      'run_replayed:1',
      'run_replayed:2',
    ])
  })
})
