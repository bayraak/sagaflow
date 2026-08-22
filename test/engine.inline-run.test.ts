import { describe, expect, it } from 'bun:test'

import { createTestRuntime, firstRun } from './helpers/runtime'
import { threeStepWorkflow } from './helpers/workflows'

describe('an inline run walks its steps and records the walk', () => {
  it('returns what the body returns', async () => {
    const { ctx } = createTestRuntime()

    const result = await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(result.deduplicated).toBe(false)
    expect(result.runId).toBe('run_1')
  })

  it('opens one run for the definition', async () => {
    const { ctx, runs } = createTestRuntime()

    await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(firstRun(runs).name).toBe('test.three-steps')
    expect(firstRun(runs).execution).toBe('inline')
    expect(firstRun(runs).tenantId).toBe('tenant_local')
    expect(firstRun(runs).input).toEqual({ mark: 'x' })
  })

  it('records every step in definition order', async () => {
    const { ctx, steps } = createTestRuntime()

    await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(steps.map((step) => [step.seq, step.name, step.status])).toEqual([
      [0, 'first', 'completed'],
      [1, 'second', 'completed'],
      [2, 'third', 'completed'],
    ])
  })

  it('records the first attempt as attempt one', async () => {
    const { ctx, steps } = createTestRuntime()

    await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(steps.every((step) => step.attempt === 1)).toBe(true)
  })

  it('closes the run as completed with its output', async () => {
    const { ctx, runs } = createTestRuntime()

    await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(firstRun(runs).status).toBe('completed')
    expect(firstRun(runs).output).toEqual({ finished: 'third:x' })
  })

  it('gives each step the run it belongs to', async () => {
    const { ctx, steps } = createTestRuntime()

    const result = await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(steps.every((step) => step.runId === result.runId)).toBe(true)
  })

  it('runs the steps in the order the body asks', async () => {
    const { ctx, invocations } = createTestRuntime()

    await threeStepWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(invocations).toEqual(['invoke:first', 'invoke:second', 'invoke:third'])
  })
})
