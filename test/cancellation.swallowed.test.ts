import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  requestCancellation,
  WorkflowCancelledError,
  WorkflowError,
  type WorkflowHandle,
} from '../src/index'
import { createTestRuntime, firstRun, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const cancelling = createStep<TestRuntime, { mark: string }, { seen: string }, { undo: string }>(
  'first',
  async (input, ctx) => {
    ctx.invocations.push('invoke:first')
    await requestCancellation(ctx.journal, { tenantId: ctx.tenantId, runId: ctx.runId })

    return { output: { seen: input.mark }, compensateWith: { undo: 'first' } }
  },
  async (undo, ctx) => {
    ctx.invocations.push(`compensate:${undo.undo}`)
  },
)

// A body is somebody else's code, and somebody else's code has try/catch in it. A body that
// swallows the cancellation — deliberately or by wrapping a step in a catch-all — must not be
// able to turn a cancelled run into a completed one. Stopping is not the body's decision.
describe('a body that swallows the cancellation', () => {
  const stubborn = defineWorkflow(
    { name: 'test.stubborn', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      try {
        await wf.step(cancelling, input)
      } catch {
        // deliberately carrying on
      }

      return { finished: input.mark }
    },
  )

  it('does not get to finish the run', async () => {
    const harness = createTestRuntime()

    const thrown = await stubborn
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(thrown instanceof WorkflowError && thrown.outcome).toBe('cancelled')
    expect(thrown instanceof WorkflowError && thrown.cause).toBeInstanceOf(WorkflowCancelledError)
  })

  it('closes the run as cancelled, with the work undone', async () => {
    const harness = createTestRuntime()

    await stubborn.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(firstRun(harness.runs).status).toBe('cancelled')
    expect(harness.invocations).toEqual(['invoke:first', 'compensate:first'])
  })

  it('runs no further step after the one that was cancelled', async () => {
    const harness = createTestRuntime()

    const persistent = defineWorkflow(
      { name: 'test.persistent', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        try {
          await wf.step(cancelling, input)
        } catch {
          // deliberately carrying on
        }
        await wf.step(markStep('second'), input)
      },
    )

    await persistent.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.invocations).not.toContain('invoke:second')
  })
})
