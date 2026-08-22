import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import {
  step,
  startDurableWorkflow,
  type DurableWorkflowHandle,
  type WorkflowHandle,
} from '../src/index.js'
import { createLauncher } from './helpers/launcher'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const child = defineWorkflow(
  { name: 'test.child', input: markInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
    await wf.step(markStep('child-step'), input)

    return { finished: input.mark }
  },
)

// A run started from inside another run's step is a fact worth writing down: without it the
// child is an orphan in the table and nobody can answer "what caused this?". It is provenance
// and nothing more — the engine reads no meaning into it, walks no tree and enforces no rule.
describe('a run started from inside another run', () => {
  it('records the run it was started from', async () => {
    const harness = createTestRuntime()

    const startsAChild = step<TestRuntime, { mark: string }, { childRunId: string }>(
      'start-child',
      {
        run: async (input, ctx) => {
          const started = await child.run({ input, ctx, parentRunId: ctx.runId })

          return { childRunId: started.runId }
        },
      },
    )

    const parent = defineWorkflow(
      { name: 'test.parent', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(startsAChild, input),
    )

    await parent.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.runs.map((run) => [run.name, run.parentRunId])).toEqual([
      ['test.parent', null],
      ['test.child', 'run_1'],
    ])
  })

  it('records nothing for a run nobody started', async () => {
    const harness = createTestRuntime()

    await child.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.runs[0]?.parentRunId).toBeNull()
  })

  it('records it for a durable run too', async () => {
    const harness = createTestRuntime()
    const { launcher } = createLauncher()

    const durableChild = defineWorkflow(
      { name: 'test.durable-child', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('only'), input)
      },
    )

    await startDurableWorkflow({
      launcher,
      definition: durableChild,
      input: { mark: 'x' },
      ctx: harness.ctx,
      parentRunId: 'run_parent',
    })

    expect(harness.runs[0]?.parentRunId).toBe('run_parent')
  })

  // Provenance, not lineage: a grandchild names its own parent, and the engine never walks up.
  it('names the immediate parent and nothing further up', async () => {
    const harness = createTestRuntime()

    const first = await child.run({ input: { mark: 'a' }, ctx: harness.ctx })
    const second = await child.run({
      input: { mark: 'b' },
      ctx: harness.ctx,
      parentRunId: first.runId,
    })
    await child.run({ input: { mark: 'c' }, ctx: harness.ctx, parentRunId: second.runId })

    expect(harness.runs.map((run) => run.parentRunId)).toEqual([null, 'run_1', 'run_2'])
  })
})
