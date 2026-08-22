import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { SagaError, type WorkflowHandle } from '../src/index.js'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const gate = (): { passed: Promise<void>; open: () => void } => {
  let open!: () => void
  const passed = new Promise<void>((resolve) => (open = resolve))

  return { passed, open }
}

// `Promise.all` over steps works and always has. It just does not read like anything in
// particular, and the reader has to know that the engine is watching it. A named group says what
// it is — and is not itself a step, so it costs nothing on a durable platform.
describe('a named parallel group', () => {
  it('answers with the results in the order they were asked for', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.group', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.all('fan-out', [
          () => wf.step('a', async () => `a:${input.mark}`),
          () => wf.step('b', async () => `b:${input.mark}`),
          () => wf.step('c', async () => `c:${input.mark}`),
        ]),
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual(['a:x', 'b:x', 'c:x'])
  })

  it('really does run them at the same time', async () => {
    const harness = createTestRuntime()
    const blocker = gate()

    const workflow = defineWorkflow(
      { name: 'test.group-concurrent', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.all('fan-out', [
          () =>
            wf.step('waiting', async () => {
              await blocker.passed

              return 'waited'
            }),
          () =>
            wf.step('opening', async () => {
              blocker.open()

              return 'opened'
            }),
        ]),
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual(['waited', 'opened'])
  })

  it('lets everything stop before it reports the failure', async () => {
    const harness = createTestRuntime()
    const finished: string[] = []
    const blocker = gate()

    const workflow = defineWorkflow(
      { name: 'test.group-failure', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.all('fan-out', [
          () =>
            wf.step('slow', async () => {
              await blocker.passed
              finished.push('slow')
            }),
          () =>
            wf.step('fast', async () => {
              blocker.open()
              finished.push('fast')

              throw new Error('fast refused')
            }),
        ]),
    )

    const thrown = await workflow
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SagaError)
    expect(((thrown as SagaError).cause as Error).message).toBe('fast refused')
    // The slow one was not abandoned mid-flight when its neighbour fell over.
    expect(finished).toEqual(['fast', 'slow'])
  })

  it('is undone in reverse start order like everything else', async () => {
    const harness = createTestRuntime()
    const undone: string[] = []

    const workflow = defineWorkflow(
      { name: 'test.group-undo', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.all('fan-out', [
          () =>
            wf.step('a', async () => 'a', {
              undo: async () => {
                undone.push('a')
              },
            }),
          () =>
            wf.step('b', async () => 'b', {
              undo: async () => {
                undone.push('b')
              },
            }),
        ])
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(undone).toEqual(['b', 'a'])
  })

  it('adds no step of its own to the trail', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.group-trail', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.all('fan-out', [() => wf.step('a', async () => 1), () => wf.step('b', async () => 2)]),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.steps.map((step) => step.name)).toEqual(['a', 'b'])
  })
})
