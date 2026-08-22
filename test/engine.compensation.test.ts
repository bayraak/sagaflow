import { describe, expect, it } from 'bun:test'

import { SagaError } from '../src/index.js'
import { createTestRuntime, firstRun } from './helpers/runtime'
import { threeStepWorkflow } from './helpers/workflows'

describe('a failing step is undone in reverse', () => {
  it('compensates the completed steps backwards', async () => {
    const { ctx, invocations } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(invocations).toEqual([
      'invoke:first',
      'invoke:second',
      'invoke:third',
      'compensate:second',
      'compensate:first',
    ])
  })

  it('never compensates the step that failed', async () => {
    const { ctx, invocations } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(invocations).not.toContain('compensate:third')
  })

  it('records the failed step as failed', async () => {
    const { ctx, steps } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    const failed = steps.find((step) => step.status === 'failed')

    expect(failed?.name).toBe('third')
    expect(failed?.seq).toBe(2)
    expect(failed?.error).toContain('third refused')
  })

  it('records each compensation as compensated', async () => {
    const { ctx, steps } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(
      steps.filter((step) => step.status === 'compensated').map((step) => [step.seq, step.name]),
    ).toEqual([
      [3, 'compensate:second'],
      [4, 'compensate:first'],
    ])
  })

  it('closes the run as compensated', async () => {
    const { ctx, runs } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(firstRun(runs).status).toBe('compensated')
    expect(firstRun(runs).error).toContain('third refused')
  })

  it('throws a workflow error carrying the run', async () => {
    const { ctx } = createTestRuntime()

    const thrown = await threeStepWorkflow({ failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SagaError)
    expect(thrown instanceof SagaError && thrown.runId).toBe('run_1')
    expect(thrown instanceof SagaError && thrown.workflowName).toBe('test.three-steps')
    expect(thrown instanceof SagaError && thrown.stepName).toBe('third')
    expect(thrown instanceof SagaError && thrown.outcome).toBe('compensated')
  })

  it('keeps the original failure as the cause', async () => {
    const { ctx } = createTestRuntime()

    const thrown = await threeStepWorkflow({ failOn: 'second' })
      .run({ input: { mark: 'x' }, ctx })
      .catch((error: unknown) => error)

    expect(thrown instanceof SagaError && (thrown.cause as Error).message).toBe('second refused')
  })

  it('does not retry a failing step inline', async () => {
    const { ctx, invocations } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'first' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(invocations.filter((entry) => entry === 'invoke:first')).toEqual(['invoke:first'])
  })

  it('skips steps that declared no compensation', async () => {
    const { ctx, invocations, runs } = createTestRuntime()

    await threeStepWorkflow({ failOn: 'third', withoutCompensationOn: 'first' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(invocations).not.toContain('compensate:first')
    expect(invocations).toContain('compensate:second')
    expect(firstRun(runs).status).toBe('compensated')
  })
})
