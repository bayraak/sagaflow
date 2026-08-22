import { describe, expect, it } from 'bun:test'

import { executeDurable, requestCancellation, SagaError } from '@bayraak/sagaflow'

import { defineWorkflow } from '../src/define.js'
import { defineStep } from '../src/step.js'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

/*
 * Finding F5, from formal/RESULTS.md, driven as a test. The worst answer this engine could
 * give, and the model found it while re-checking the fixes for the others.
 *
 * A run unwinds — every step it took is reversed — and the instance dies before the write that
 * would have recorded that. The run row still says `running`, so nothing refuses the next
 * invocation. Every step is memoised, so the body reaches the end without running anything
 * fresh and without any step re-reading the flag that started the unwind. It then closes
 * COMPLETED: the caller is told the work succeeded, while every effect it produced has already
 * been reversed.
 *
 * No invariant in the study caught this before, which is why I9 now exists: a run that closed
 * completed undid nothing.
 */
const unwoundThenReinvoked = async (): Promise<{
  harness: ReturnType<typeof createTestRuntime>
  ran: string[]
  outcome: unknown
}> => {
  const harness = createTestRuntime()
  const ran: string[] = []

  const only = defineStep<TestRuntime, { mark: string }, { seen: string }>('only', {
    run: async (input, ctx) => {
      ran.push('only')
      await requestCancellation({ journal: ctx.journal, tenantId: ctx.tenantId, runId: ctx.runId })

      return { seen: input.mark }
    },
    undo: async () => {
      ran.push('undo:only')
    },
  })

  const workflow = defineWorkflow(
    { name: 'formal.f5', input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf) => {
      await wf.step(only, input)

      return { finished: input.mark }
    },
  )

  const runId = await harness.journal.insertRun({
    tenantId: 'tenant_local',
    name: 'formal.f5',
    execution: 'durable',
    idempotencyKey: null,
    input: { mark: 'x' },
  })

  const platform = createCachingPrimitive({ crashOnce: ['finish-run'] })

  await executeDurable(workflow, { runId, input: { mark: 'x' } }, harness.ctx, platform.primitive())
    .then(() => undefined)
    .catch(() => undefined)

  const outcome = await executeDurable(
    workflow,
    { runId, input: { mark: 'x' } },
    harness.ctx,
    platform.primitive(),
  ).then(
    (value: unknown) => ({ returned: value }),
    (error: unknown) => error,
  )

  return { harness, ran, outcome }
}

describe('F5 — a run re-invoked after it was fully unwound', () => {
  it('does not report success for work that has been reversed', async () => {
    const { outcome } = await unwoundThenReinvoked()

    expect(outcome).toBeInstanceOf(SagaError)
  })

  it('closes the run as unwound, not as completed', async () => {
    const { harness } = await unwoundThenReinvoked()

    expect(harness.runs[0]?.status).toBe('compensated')
  })

  it('announces the closure of an unwound run, never a completion', async () => {
    const { harness } = await unwoundThenReinvoked()

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
  })

  it('does not run the undo a second time', async () => {
    const { ran } = await unwoundThenReinvoked()

    expect(ran).toEqual(['only', 'undo:only'])
  })
})
