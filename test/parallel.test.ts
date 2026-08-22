import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  executeDurable,
  type DurableWorkflowHandle,
  type WorkflowHandle,
} from '../src/index'
import { createCachingPrimitive, passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// A gate, so the order the steps FINISH in is the opposite of the order they were STARTED in.
// Without it a suite cannot tell those two orders apart, and the difference is the whole
// promise: completion order is not stable across a durable re-invocation, because cached steps
// complete in the order they were called.
const createGate = () => {
  let open!: () => void
  const passed = new Promise<void>((resolve) => (open = resolve))

  return { passed, open }
}

const gatedSteps = () => {
  const gate = createGate()

  const slow = createStep<TestRuntime, { mark: string }, { seen: string }>('slow', {
    run: async (input, ctx) => {
      ctx.invocations.push('invoke:slow')
      await gate.passed

      return { seen: input.mark }
    },
    compensate: async (_seen, ctx) => {
      ctx.invocations.push(`compensate:slow`)
    },
  })

  const quick = createStep<TestRuntime, { mark: string }, { seen: string }>('quick', {
    run: async (input, ctx) => {
      ctx.invocations.push('invoke:quick')
      gate.open()

      return { seen: input.mark }
    },
    compensate: async (_seen, ctx) => {
      ctx.invocations.push(`compensate:quick`)
    },
  })

  return { slow, quick }
}

describe('steps a body runs at the same time', () => {
  it('runs both and returns both results', async () => {
    const harness = createTestRuntime()
    const { slow, quick } = gatedSteps()

    const workflow = defineWorkflow(
      { name: 'test.parallel', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        Promise.all([wf.step(slow, input), wf.step(quick, input)]),
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual([{ seen: 'x' }, { seen: 'x' }])
  })

  it('gives each of them a position of its own', async () => {
    const harness = createTestRuntime()
    const { slow, quick } = gatedSteps()

    const workflow = defineWorkflow(
      { name: 'test.parallel-seq', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await Promise.all([wf.step(slow, input), wf.step(quick, input)])
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.steps.map((step) => [step.name, step.seq]).toSorted()).toEqual([
      ['quick', 1],
      ['slow', 0],
    ])
  })

  // Reverse START order. The obvious alternative — reverse completion order — is not stable
  // across a durable re-invocation: replayed steps complete instantly in the order they were
  // called, so the same body would unwind one way on the first invocation and another way on
  // the second. Start order is a property of the body; completion order is a property of the
  // weather.
  it('undoes the one that started last, first', async () => {
    const harness = createTestRuntime()
    const { slow, quick } = gatedSteps()

    const workflow = defineWorkflow(
      { name: 'test.parallel-undo', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await Promise.all([wf.step(slow, input), wf.step(quick, input)])
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.invocations).toEqual([
      'invoke:slow',
      'invoke:quick',
      'invoke:boom',
      'compensate:quick',
      'compensate:slow',
    ])
  })

  it('does the same through a durable platform', async () => {
    const harness = createTestRuntime()
    const { slow, quick } = gatedSteps()

    const workflow = defineWorkflow(
      { name: 'test.parallel-durable', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await Promise.all([wf.step(slow, input), wf.step(quick, input)])
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_parallel', input: { mark: 'x' } },
      harness.ctx,
      passThroughPrimitive(),
    ).catch(() => undefined)

    expect(harness.invocations).toEqual([
      'invoke:slow',
      'invoke:quick',
      'invoke:boom',
      'compensate:quick',
      'compensate:slow',
    ])
  })

  // The reason for start order, stated as a test: drive the very same body twice through a
  // platform that memoises what it has already done, and the unwinding has to look identical
  // both times. Under completion order it would not — on the replay the gated step comes back
  // from the journal first, so it would finish first and be undone last.
  it('unwinds identically when the same run is invoked again', async () => {
    const harness = createTestRuntime()
    const { slow, quick } = gatedSteps()
    const platform = createCachingPrimitive({ neverCache: ['boom', 'finish-run'] })

    const workflow = defineWorkflow(
      { name: 'test.parallel-replay', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await Promise.all([wf.step(slow, input), wf.step(quick, input)])
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    const unwindings: string[][] = []
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const before = platform.calls.length
      await executeDurable(
        workflow,
        { runId: 'run_parallel_replay', input: { mark: 'x' } },
        harness.ctx,
        platform.primitive(),
      ).catch(() => undefined)
      unwindings.push(platform.calls.slice(before).filter((name) => name.startsWith('compensate:')))
    }

    expect(unwindings).toEqual([
      ['compensate:quick', 'compensate:slow'],
      ['compensate:quick', 'compensate:slow'],
    ])
  })
})
