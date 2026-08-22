import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { type WorkflowHandle } from '../src/index.js'
import { createTestRuntime, firstRun } from './helpers/runtime'
import type { TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const keyedWorkflow = () => {
  const only = markStep('only')

  return defineWorkflow(
    {
      name: 'test.keyed',
      input: markInput,
      execution: 'inline',
      idempotency: (input) => `test.keyed:${input.mark}`,
    },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      const seen = await wf.step(only, input)

      return { finished: seen.seen }
    },
  )
}

describe('an idempotency key answers instead of re-executing', () => {
  it('runs the steps the first time', async () => {
    const { ctx, invocations, runs } = createTestRuntime()

    await keyedWorkflow().run({ input: { mark: 'once' }, ctx })

    expect(invocations).toEqual(['invoke:only'])
    expect(firstRun(runs).idempotencyKey).toBe('test.keyed:once')
  })

  it('does not execute a second time', async () => {
    const { ctx, invocations } = createTestRuntime()
    const workflow = keyedWorkflow()

    await workflow.run({ input: { mark: 'once' }, ctx })
    await workflow.run({ input: { mark: 'once' }, ctx })

    expect(invocations).toEqual(['invoke:only'])
  })

  it('answers with the first run', async () => {
    const { ctx, runs } = createTestRuntime()
    const workflow = keyedWorkflow()

    const first = await workflow.run({ input: { mark: 'once' }, ctx })
    const second = await workflow.run({ input: { mark: 'once' }, ctx })

    expect(second.runId).toBe(first.runId)
    expect(second.deduplicated).toBe(true)
    expect(runs).toHaveLength(1)
  })

  it('answers with the first output and status', async () => {
    const { ctx } = createTestRuntime()
    const workflow = keyedWorkflow()

    await workflow.run({ input: { mark: 'once' }, ctx })
    const second = await workflow.run({ input: { mark: 'once' }, ctx })

    expect(second.output).toEqual({ finished: 'only:once' })
    expect(second.deduplicated && second.status).toBe('completed')
  })

  it('derives the key from the input', async () => {
    const { ctx, runs } = createTestRuntime()
    const workflow = keyedWorkflow()

    await workflow.run({ input: { mark: 'alpha' }, ctx })
    await workflow.run({ input: { mark: 'beta' }, ctx })

    expect(runs.map((run) => run.idempotencyKey)).toEqual(['test.keyed:alpha', 'test.keyed:beta'])
  })

  it('lets a different key run again', async () => {
    const { ctx, invocations } = createTestRuntime()
    const workflow = keyedWorkflow()

    await workflow.run({ input: { mark: 'alpha' }, ctx })
    await workflow.run({ input: { mark: 'beta' }, ctx })

    expect(invocations).toEqual(['invoke:only', 'invoke:only'])
  })
})
