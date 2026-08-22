import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { step, type WorkflowHandle } from '../src/index.js'
import { createTestRuntime, firstRun, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const late = step<TestRuntime, { mark: string }, { seen: string }>('late', {
  run: async (input, ctx) => {
    await settle(5)
    ctx.invocations.push('invoke:late')

    return { seen: input.mark }
  },
  undo: async (_seen, ctx) => {
    ctx.invocations.push(`compensate:late`)
  },
})

const early = step<TestRuntime, { mark: string }, { seen: string }>('early', {
  run: async (_input, ctx) => {
    ctx.invocations.push('invoke:early')

    throw new Error('early refused')
  },
})

// Promise.all rejects the moment the first of them does, while the others are still running.
// If the engine started unwinding there and then, a step that finished a millisecond later
// would register an undo that nobody was left to run — the effect stays, the run says it was
// compensated, and the two disagree for ever.
describe('a step still running when another one fails', () => {
  const racing = defineWorkflow(
    { name: 'test.inflight', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await Promise.all([wf.step(late, input), wf.step(early, input)])
    },
  )

  it('is waited for before the unwinding starts', async () => {
    const harness = createTestRuntime()

    await racing.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.invocations).toEqual(['invoke:early', 'invoke:late', 'compensate:late'])
  })

  it('has its work undone', async () => {
    const harness = createTestRuntime()

    await racing.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.steps.map((row) => [row.name, row.status])).toEqual([
      ['early', 'failed'],
      ['late', 'completed'],
      ['compensate:late', 'compensated'],
    ])
  })

  it('closes the run only once everything has stopped', async () => {
    const harness = createTestRuntime()

    await racing.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.finishes).toHaveLength(1)
    expect(firstRun(harness.runs).status).toBe('compensated')
  })
})
