import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { type WorkflowHandle } from '../src/index.js'
import { defineStep } from '../src/step.js'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

// An inline run holds a request open, so it does not spend a retry budget nobody asked it to.
// But a step that DID ask deserves to be believed — a flaky provider call inside a 200 ms
// mutation is exactly the case where two quick attempts beat compensating the whole saga.
describe('an inline step that asked to be retried', () => {
  it('is retried, and the trail shows every attempt', async () => {
    const harness = createTestRuntime()
    const attempts: number[] = []

    const flaky = defineStep<TestRuntime, { mark: string }, string>('flaky', {
      run: async (_input, ctx) => {
        attempts.push(ctx.attempt)
        if (ctx.attempt < 3) throw new Error('not yet')

        return 'eventually'
      },
      retries: { limit: 2, delay: 0 },
    })

    const workflow = defineWorkflow(
      { name: 'test.inline-retry', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => wf.step(flaky, input),
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(attempts).toEqual([1, 2, 3])
    expect(!result.deduplicated && result.output).toBe('eventually')
    expect(harness.steps.map((row) => [row.attempt, row.status])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'completed'],
    ])
  })

  it('gives up when the budget is spent, and compensates', async () => {
    const harness = createTestRuntime()
    let seen = 0

    const hopeless = defineStep<TestRuntime, { mark: string }, string>('hopeless', {
      run: async () => {
        seen += 1

        throw new Error('never')
      },
      retries: { limit: 1, delay: 0 },
    })

    const workflow = defineWorkflow(
      { name: 'test.inline-retry-out', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => wf.step(hopeless, input),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(seen).toBe(2)
    expect(harness.runs[0]?.status).toBe('compensated')
  })

  it('leaves a step that asked for nothing alone', async () => {
    const harness = createTestRuntime()
    let seen = 0

    const workflow = defineWorkflow(
      { name: 'test.inline-no-retry', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step('once', async () => {
          seen += 1

          throw new Error('never')
        }),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(seen).toBe(1)
  })

  it('keeps the idempotency key steady across those attempts', async () => {
    const harness = createTestRuntime()
    const keys: string[] = []

    const workflow = defineWorkflow(
      { name: 'test.inline-retry-key', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(
          'flaky',
          async (ctx) => {
            keys.push(ctx.idempotencyKey)
            if (ctx.attempt < 2) throw new Error('not yet')

            return ctx.attempt
          },
          { retries: { limit: 3, delay: 0 } },
        ),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(keys).toEqual(['run_1:0', 'run_1:0'])
  })
})
