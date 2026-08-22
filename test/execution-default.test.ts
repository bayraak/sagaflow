import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { type WorkflowHandle } from '../src/index.js'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

// Inline is what most mutations are, and saying so on every definition is ceremony. Durable is
// the decision worth writing down, so that is the one you have to write down.
describe('a definition that does not say how it runs', () => {
  it('is inline, and can run itself', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.default-execution', input: markInput },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step('write', async () => ({ written: input.mark })),
    )

    expect(workflow.execution).toBe('inline')

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ written: 'x' })
    expect(harness.runs[0]?.execution).toBe('inline')
  })

  it('still takes every other option', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.default-execution-keyed', input: markInput, idempotency: true },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step('write', async () => ({ written: input.mark })),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })
    const second = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(second.deduplicated).toBe(true)
  })
})
