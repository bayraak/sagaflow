import { describe, expect, it } from 'bun:test'

import { createTestRuntime } from './helpers/runtime'
import { threeStepWorkflow } from './helpers/workflows'

describe('a definition validates its input before anything happens', () => {
  it('rejects an input its schema refuses', async () => {
    const { ctx } = createTestRuntime()

    expect(threeStepWorkflow().run({ input: { mark: '' }, ctx })).rejects.toThrow()
  })

  it('leaves no run behind when the input is refused', async () => {
    const { ctx, runs, invocations } = createTestRuntime()

    await threeStepWorkflow()
      .run({ input: { nothing: 'like the schema' }, ctx })
      .catch(() => undefined)

    expect(runs).toEqual([])
    expect(invocations).toEqual([])
  })

  it('hands the parsed input to the body', async () => {
    const { ctx } = createTestRuntime()

    const result = await threeStepWorkflow().run({ input: { mark: 'hello' }, ctx })

    expect(!result.deduplicated && result.output).toEqual({ finished: 'third:hello' })
  })
})
