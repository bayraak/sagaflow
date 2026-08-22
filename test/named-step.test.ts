import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import {
  executeDurable,
  namedStep,
  SagaError,
  type DurableWorkflowHandle,
  type StepBudget,
  type WorkflowHandle,
} from '../src/index.js'
import { createFakePrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// A durable instance keys its journal by STEP NAME, so one definition used twice in one run is
// one step to the platform — and the second use would be handed the first use's memoised
// result. Anything that repeats a step has to name each use.
const twiceOverWorkflow = defineWorkflow(
  { name: 'test.twice-over', input: markInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
    const shared = markStep('shared')

    const first = await wf.step(namedStep(shared, 'shared-a'), { mark: input.mark })
    const second = await wf.step(namedStep(shared, 'shared-b'), { mark: input.mark })

    return [first.seen, second.seen]
  },
)

// A borrowed step is used somewhere its failures mean something else. The default budget is
// written for a step that talks to somebody else's service; borrowed into a fan-out where the
// common failure is permanent, waiting a minute per item to learn what the first attempt
// already knew is the cost of not saying so.
const borrowedBudget: StepBudget = { retries: { limit: 1, delay: '1 second' } }

describe('one step, used more than once in a run', () => {
  it('is recorded under two names', async () => {
    const { ctx, steps } = createTestRuntime()
    await twiceOverWorkflow.run({ input: { mark: 'x' }, ctx })

    expect(steps.map((step) => step.name)).toEqual(['shared-a', 'shared-b'])
  })

  it('does the work twice', async () => {
    const { ctx, invocations } = createTestRuntime()
    await twiceOverWorkflow.run({ input: { mark: 'x' }, ctx })

    expect(invocations.filter((entry) => entry === 'invoke:shared')).toHaveLength(2)
  })

  it('leaves the original alone', () => {
    const shared = markStep('shared')
    namedStep(shared, 'shared-a')

    expect(shared.name).toBe('shared')
  })

  it('keeps its undo', async () => {
    const { ctx, invocations } = createTestRuntime()
    const shared = markStep('shared')

    const failing = defineWorkflow(
      { name: 'test.twice-over-failing', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(namedStep(shared, 'shared-a'), { mark: input.mark })
        await wf.step(markStep('boom', { fails: true }), { mark: input.mark })
      },
    )

    expect(failing.run({ input: { mark: 'x' }, ctx })).rejects.toThrow(SagaError)
    await failing.run({ input: { mark: 'y' }, ctx }).catch(() => undefined)
    expect(invocations).toContain('compensate:shared')
  })

  it('can carry its own budget', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive()
    const shared = markStep('shared')

    const workflow = defineWorkflow(
      { name: 'test.borrowed-budget', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(namedStep(shared, 'shared-a', borrowedBudget), { mark: input.mark })
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_budget', input: { mark: 'x' } },
      harness.ctx,
      primitive,
    )

    expect(calls.find((call) => call.name === 'shared-a')?.config).toEqual(borrowedBudget)
  })

  it('leaves the original budget alone', () => {
    const shared = markStep('shared')
    namedStep(shared, 'shared-a', borrowedBudget)

    expect(shared.config).not.toEqual(borrowedBudget)
  })
})
