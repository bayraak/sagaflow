import { describe, expect, it } from 'bun:test'

import { executeDurable } from '../src/index.js'
import { durableCompletingWorkflow } from './helpers/edges'
import { passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime } from './helpers/runtime'

const driveTwice = async (harness: ReturnType<typeof createTestRuntime>) => {
  const workflow = durableCompletingWorkflow()

  await executeDurable(
    workflow,
    { runId: 'run_same', input: { mark: 'x' } },
    harness.ctx,
    passThroughPrimitive(),
  )
  await executeDurable(
    workflow,
    { runId: 'run_same', input: { mark: 'x' } },
    harness.ctx,
    passThroughPrimitive(),
  )
}

describe('the same durable run driven twice', () => {
  it('closes twice', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    expect(harness.finishes.map((finish) => finish.runId)).toEqual(['run_same', 'run_same'])
    expect(harness.finishes.every((finish) => finish.status === 'completed')).toBe(true)
  })

  // The edge that used to be honest and is now closed: a second finish writes the SAME events
  // again under the SAME envelope ids, so the second write lands on rows that already exist
  // and any consumer that dedupes on id recognises the repeat.
  it('writes the same ids both times, which the outbox and the consumer recognise', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    const written = harness.finishes.map((finish) =>
      finish.events.filter((event) => event.type === 'invoice.voided').map((event) => event.id),
    )

    expect(written).toEqual([['run_same:0'], ['run_same:0']])
    expect(harness.outbox.filter((message) => message.type === 'invoice.voided')).toHaveLength(1)
  })

  // A pass-through primitive memoises nothing, so the drain runs again — and sends the very
  // same messages, which is the safe direction of an at-least-once delivery.
  it('drains twice, carrying the same messages', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    expect(harness.batches).toHaveLength(2)
    expect(harness.batches[0]?.map((message) => message.id)).toEqual(
      harness.batches[1]?.map((message) => message.id) ?? [],
    )
  })
})
