import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { startDurableWorkflow, sweepAbandonedRuns } from '../src/index.js'
import type { DurableWorkflowHandle } from '../src/index.js'
import { createMemoryJournal } from '../src/memory/index'
import { completingWorkflow, failingWorkflow } from './helpers/edges'
import { createLauncher } from './helpers/launcher'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const minute = 60_000

// "Exactly one lifecycle event per closed run" is either an invariant somebody can build on or
// it is a sentence in a README. Two paths used to close a run silently: the sweeper that fails
// an abandoned run, and a start whose platform refused after the run record already existed.
// A consumer counting runs from the stream would have been quietly short.
describe('every closed run announces itself, once', () => {
  it('does for a run that completed', async () => {
    const harness = createTestRuntime()

    await completingWorkflow().run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.outbox.filter((event) => event.type.startsWith('workflow.'))).toHaveLength(1)
  })

  it('does for a run that was undone', async () => {
    const harness = createTestRuntime()

    await failingWorkflow()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
  })

  it('does for a run nobody was left to finish', async () => {
    let clock = 0
    const memory = createMemoryJournal({ now: () => clock })
    const runId = await memory.journal.insertRun({
      tenantId: 'tenant_local',
      name: 'invoice.create',
      execution: 'inline',
      idempotencyKey: null,
      input: {},
    })

    clock = 10 * minute
    const swept = await sweepAbandonedRuns({
      journal: memory.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(swept).toBe(1)
    expect(memory.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
    expect(memory.outbox[0]?.payload).toEqual({
      runId,
      name: 'invoice.create',
      error: 'abandoned: no finish after 300000ms',
      outcome: 'failed',
    })
    expect(memory.outbox[0]?.id).toBe(`${runId}:swept`)
    expect(memory.outbox[0]?.tenantId).toBe('tenant_local')
  })

  it('does for a run whose platform refused to start it', async () => {
    const harness = createTestRuntime()
    const { launcher } = createLauncher({ refusesWith: new Error('the platform is unavailable') })

    const definition = defineWorkflow(
      { name: 'invoice.send', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('only'), input)
      },
    )

    await startDurableWorkflow({
      launcher,
      definition,
      input: { mark: 'x' },
      ctx: harness.ctx,
    }).catch(() => undefined)

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
    expect(harness.outbox[0]?.payload).toMatchObject({
      name: 'invoice.send',
      outcome: 'failed',
    })
  })

  // Sweeping twice is a cron doing its job, not a second failure to announce.
  it('does not announce a swept run a second time', async () => {
    let clock = 0
    const memory = createMemoryJournal({ now: () => clock })
    await memory.journal.insertRun({
      tenantId: 'tenant_local',
      name: 'invoice.create',
      execution: 'inline',
      idempotencyKey: null,
      input: {},
    })

    clock = 10 * minute
    await sweepAbandonedRuns({ journal: memory.journal, now: clock, olderThanMs: 5 * minute })
    const second = await sweepAbandonedRuns({
      journal: memory.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(second).toBe(0)
    expect(memory.outbox).toHaveLength(1)
  })
})
