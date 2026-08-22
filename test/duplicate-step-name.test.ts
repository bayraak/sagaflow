import { describe, expect, it } from 'bun:test'

import {
  defineWorkflow,
  executeDurable,
  namedStep,
  WorkflowError,
  type DurableWorkflowHandle,
  type WorkflowHandle,
} from '../src/index'
import { passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// The single most expensive durable bug there is, and it is completely silent: a durable
// platform memoises step results BY NAME, so the second use of one definition in one run is
// handed the first use's result and the work it was asked to do never happens. The invoice is
// sent to the first recipient three times and the other two hear nothing.
describe('one step definition used twice in one run', () => {
  it('is refused inline, where it would otherwise quietly work', async () => {
    const harness = createTestRuntime()
    const shared = markStep('shared')

    const workflow = defineWorkflow(
      { name: 'test.duplicate-inline', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(shared, input)
        await wf.step(shared, input)
      },
    )

    const thrown = await workflow
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(((thrown as WorkflowError).cause as Error).message).toBe(
      `step "shared" was already used in this run — wrap it with namedStep(step, "shared-2")`,
    )
  })

  it('is refused durably, where it would be silently wrong', async () => {
    const harness = createTestRuntime()
    const shared = markStep('shared')

    const workflow = defineWorkflow(
      { name: 'test.duplicate-durable', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(shared, input)
        await wf.step(shared, input)
      },
    )

    const thrown = await executeDurable(
      workflow,
      { runId: 'run_given', input: { mark: 'x' } },
      harness.ctx,
      passThroughPrimitive(),
    ).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(((thrown as WorkflowError).cause as Error).message).toContain('already used in this run')
  })

  it('undoes what the first use had already done', async () => {
    const harness = createTestRuntime()
    const shared = markStep('shared')

    const workflow = defineWorkflow(
      { name: 'test.duplicate-undo', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(shared, input)
        await wf.step(shared, input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.invocations).toEqual(['invoke:shared', 'compensate:shared'])
  })

  it('is exactly what namedStep is for', async () => {
    const harness = createTestRuntime()
    const shared = markStep('shared')

    const workflow = defineWorkflow(
      { name: 'test.duplicate-named', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(namedStep(shared, 'shared-a'), input)
        await wf.step(namedStep(shared, 'shared-b'), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.steps.map((step) => step.name)).toEqual(['shared-a', 'shared-b'])
  })
})
