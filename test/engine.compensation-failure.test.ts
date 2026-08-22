import { describe, expect, it } from 'bun:test'

import { SagaError } from '../src/index.js'
import { createTestRuntime, firstRun } from './helpers/runtime'
import { threeStepWorkflow } from './helpers/workflows'

describe('a compensation that itself fails does not stop the others', () => {
  it('still compensates the remaining steps', async () => {
    const { ctx, invocations } = createTestRuntime()

    await threeStepWorkflow({ compensateFailsOn: 'second', failOn: 'third' })
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

  it('records the failed compensation as failed', async () => {
    const { ctx, steps } = createTestRuntime()

    await threeStepWorkflow({ compensateFailsOn: 'second', failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    const compensation = steps.find((step) => step.name === 'compensate:second')

    expect(compensation?.status).toBe('failed')
    expect(compensation?.error).toContain('second could not be undone')
  })

  it('closes the run as failed, not compensated', async () => {
    const { ctx, runs } = createTestRuntime()

    const thrown = await threeStepWorkflow({ compensateFailsOn: 'second', failOn: 'third' })
      .run({ input: { mark: 'x' }, ctx })
      .catch((error: unknown) => error)

    expect(firstRun(runs).status).toBe('failed')
    expect(thrown instanceof SagaError && thrown.outcome).toBe('failed')
  })
})
