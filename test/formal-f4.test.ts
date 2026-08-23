import { describe, expect, it } from 'bun:test'

import { executeDurable, requestCancellation } from 'sagaflow-js'

import { defineWorkflow } from '../src/define.js'
import { defineStep } from '../src/step.js'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

/*
 * Finding F4, from formal/RESULTS.md, driven as a test.
 *
 * The residual that the model still refuted after F1 and F2 were fixed, and the same family as
 * both: a re-invocation walking past the point at which the last one stopped. Here the run was
 * never closed, so the entry guard does not engage — it began UNWINDING and the instance died
 * before the finish. The re-invocation replays the memoised steps, and a memoised step never
 * calls `recordStep` and so never re-reads the cancellation flag that started the unwind. The
 * body then reaches a step that never ran and runs it FOR REAL, against a run that had already
 * decided to go down, and its undo lands after an undo that started earlier had already
 * succeeded. Undo order across the two invocations comes out forward.
 *
 * TLC refuted I4b and I4d on exactly this trace.
 */
const cancelledMidUnwindThenReinvoked = async (): Promise<{
  harness: ReturnType<typeof createTestRuntime>
  ran: string[]
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

  const second = defineStep<TestRuntime, { mark: string }, { seen: string }>('second', {
    run: async (input) => {
      ran.push('second')

      return { seen: input.mark }
    },
    undo: async () => {
      ran.push('undo:second')
    },
  })

  const workflow = defineWorkflow(
    { name: 'formal.f4', input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf) => {
      await wf.step(first, input)
      await wf.step(second, input)
    },
  )

  const runId = await harness.journal.insertRun({
    tenantId: 'tenant_local',
    name: 'formal.f4',
    execution: 'durable',
    idempotencyKey: null,
    input: { mark: 'x' },
  })

  // The unwind of the first invocation is done and the write that would have closed the run
  // never happens. The run row still says `running`, so nothing refuses the next invocation.
  const platform = createCachingPrimitive({ crashOnce: ['finish-run'] })

  await executeDurable(workflow, { runId, input: { mark: 'x' } }, harness.ctx, platform.primitive())
    .then(() => undefined)
    .catch(() => undefined)

  await executeDurable(workflow, { runId, input: { mark: 'x' } }, harness.ctx, platform.primitive())
    .then(() => undefined)
    .catch(() => undefined)

  return { harness, ran }
}

describe('F4 — a run re-invoked after it had begun unwinding', () => {
  it('does not carry the body any further than the unwind let it get', async () => {
    const { ran } = await cancelledMidUnwindThenReinvoked()

    expect(ran).not.toContain('second')
  })

  it('undoes in reverse start order across the two invocations', async () => {
    const { ran } = await cancelledMidUnwindThenReinvoked()

    expect(ran.filter((entry) => entry.startsWith('undo:'))).toEqual(['undo:first'])
  })

  // Compensated rather than cancelled: the invocation that decided to stop never got its
  // decision written down, and this one cannot invent a reason nobody recorded. Both statuses
  // mean the same thing about the world — the run was fully unwound and nothing is standing.
  it('still closes the run, fully unwound', async () => {
    const { harness } = await cancelledMidUnwindThenReinvoked()

    expect(harness.runs[0]?.status).toBe('compensated')
  })
})
