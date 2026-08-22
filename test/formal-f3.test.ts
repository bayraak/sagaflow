import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { startDurableWorkflow, sweepAbandonedRuns, type WorkflowHandle } from '../src/index.js'
import { createLauncher } from './helpers/launcher'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

/*
 * Finding F3, from formal/RESULTS.md, driven as a test.
 *
 * The sweeper minted its announcement at ordinal 0, reasoning that a run it is closing emitted
 * nothing — it never reached its finish. That is sound about a run that really is dead and
 * unsound as an identity: ordinal 0 is also the id of the run's own first emission. When the
 * window is misconfigured and the sweeper closes a run that is still going, both reach for the
 * same envelope id, the status guard correctly refuses the late status write, and `on conflict
 * do nothing` resolves the outbox collision by throwing away whichever arrived second. An event
 * the run really did emit stops existing anywhere.
 *
 * The ablation is gated on a misconfiguration, which is exactly why the collision must be made
 * impossible rather than left improbable: it costs nothing to make the two ids different.
 */
const sweptMidRun = async (): Promise<ReturnType<typeof createTestRuntime>> => {
  const harness = createTestRuntime()

  const workflow = defineWorkflow(
    { name: 'formal.f3', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      wf.emit('invoice.issued', { invoiceId: input.mark, total: 1 })

      // The window was set shorter than this request takes, so the sweeper decides a run that
      // is still going has been abandoned, and closes it — before the run's own finish lands.
      await sweepAbandonedRuns({
        journal: harness.ctx.journal,
        now: Date.now() + 60_000,
        olderThanMs: 0,
      })

      return { finished: input.mark }
    },
  )

  await workflow.run({ input: { mark: 'F3' }, ctx: harness.ctx }).catch(() => undefined)

  return harness
}

describe('F3 — a sweeper closing a run that is still going', () => {
  it('does not take the id of an event the run really emitted', async () => {
    const harness = await sweptMidRun()

    expect(harness.outbox.map((event) => event.type)).toContain('invoice.issued')
  })

  it('gives every envelope of that run its own row', async () => {
    const harness = await sweptMidRun()

    expect(new Set(harness.outbox.map((event) => event.id)).size).toBe(harness.outbox.length)
    expect(harness.outbox).toHaveLength(3)
  })

  it('identifies the sweep by what it is rather than by an ordinal', async () => {
    const harness = await sweptMidRun()
    const runId = harness.runs[0]?.id

    expect(harness.outbox.map((event) => event.id).toSorted()).toEqual([
      `${runId}:0`,
      `${runId}:completed`,
      `${runId}:swept`,
    ])
  })
})

describe('F3 — a start the platform refused', () => {
  it('identifies the refusal by what it is rather than by an ordinal', async () => {
    const harness = createTestRuntime()
    const { launcher } = createLauncher({ refusesWith: new Error('the platform is unavailable') })

    await startDurableWorkflow({
      launcher,
      definition: defineWorkflow(
        { name: 'formal.f3-start', input: markInput, execution: 'durable' },
        async (input: { mark: string }) => ({ finished: input.mark }),
      ),
      input: { mark: 'F3' },
      ctx: harness.ctx,
    }).catch(() => undefined)

    expect(harness.finishes[0]?.events?.map((event) => event.id)).toEqual([
      `${harness.runs[0]?.id}:start-refused`,
    ])
  })
})
