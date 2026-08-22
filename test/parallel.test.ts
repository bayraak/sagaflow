import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  executeDurable,
  type DurableWorkflowHandle,
  type WorkflowHandle,
} from '../src/index'
import { passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// A gate, so the order the steps FINISH in is the opposite of the order the body asked for
// them. Without it a suite cannot tell "undone in reverse completion order" apart from
// "undone in reverse definition order", and those are different promises.
const createGate = () => {
  let open!: () => void
  const passed = new Promise<void>((resolve) => (open = resolve))

  return { passed, open }
}

const gatedSteps = () => {
  const gate = createGate()

  const slow = createStep<TestRuntime, { mark: string }, { seen: string }, { undo: string }>(
    'slow',
    async (input, ctx) => {
      ctx.invocations.push('invoke:slow')
      await gate.passed

      return { output: { seen: input.mark }, compensateWith: { undo: 'slow' } }
    },
    async (undo, ctx) => {
      ctx.invocations.push(`compensate:${undo.undo}`)
    },
  )

  const quick = createStep<TestRuntime, { mark: string }, { seen: string }, { undo: string }>(
    'quick',
    async (input, ctx) => {
      ctx.invocations.push('invoke:quick')
      gate.open()

      return { output: { seen: input.mark }, compensateWith: { undo: 'quick' } }
    },
    async (undo, ctx) => {
      ctx.invocations.push(`compensate:${undo.undo}`)
    },
  )

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

  // Reverse COMPLETION order, not reverse definition order. A saga undoes what it did in the
  // order it actually did it, and with concurrency those two orders come apart.
  it('undoes the one that finished last, first', async () => {
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
      'compensate:slow',
      'compensate:quick',
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
      'compensate:slow',
      'compensate:quick',
    ])
  })
})
