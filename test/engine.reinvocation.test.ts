import { describe, expect, it } from 'bun:test'

import { executeDurable } from '../src/index'
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

  // The honest edge, written down rather than assumed away: a second finish writes the SAME
  // events again under NEW envelope ids, so the consumer's id-dedupe cannot recognise them as
  // repeats.
  it('writes fresh ids the consumer cannot recognise as repeats', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    const voided = harness.outbox.filter((message) => message.type === 'invoice.voided')

    expect(voided).toHaveLength(2)
    expect(voided[0]?.id).not.toBe(voided[1]?.id)
  })

  it('drains twice', async () => {
    const harness = createTestRuntime()

    await driveTwice(harness)

    expect(harness.batches).toHaveLength(2)
  })
})
