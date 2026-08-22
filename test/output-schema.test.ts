import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import { defineWorkflow, WorkflowError, type WorkflowHandle } from '../src/index'
import { createTestRuntime, firstRun, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const receipt = z.object({ invoiceNumber: z.string().min(1) })

const issuing = (options: { emptyNumber?: boolean } = {}) =>
  defineWorkflow(
    { name: 'test.issuing', input: markInput, execution: 'inline', output: receipt },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(markStep('issue'), input)

      return { invoiceNumber: options.emptyNumber ? '' : input.mark }
    },
  )

// A body that returns the wrong thing is a body that failed, however cheerfully it returned.
// The run had promised its caller a shape, and the last honest moment to notice it did not
// keep that promise is before the run is written down as completed.
describe('a workflow can declare what it returns', () => {
  it('passes an output the schema accepts straight through', async () => {
    const harness = createTestRuntime()

    const result = await issuing().run({ input: { mark: 'INV-1' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ invoiceNumber: 'INV-1' })
    expect(firstRun(harness.runs).status).toBe('completed')
  })

  it('compensates a run whose output the schema refuses', async () => {
    const harness = createTestRuntime()

    const thrown = await issuing({ emptyNumber: true })
      .run({ input: { mark: 'INV-2' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(harness.invocations).toEqual(['invoke:issue', 'compensate:issue'])
    expect(firstRun(harness.runs).status).toBe('compensated')
  })

  it('never closes the run as completed on a refused output', async () => {
    const harness = createTestRuntime()

    await issuing({ emptyNumber: true })
      .run({ input: { mark: 'INV-3' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.finishes.map((finish) => finish.status)).toEqual(['compensated'])
    expect(harness.sent).toEqual([])
  })

  it('records what the schema produced, not what the body returned', async () => {
    const harness = createTestRuntime()

    const stamped = defineWorkflow(
      {
        name: 'test.stamped',
        input: markInput,
        execution: 'inline',
        output: receipt.transform((value) => ({ ...value, stamped: true })),
      },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('issue'), input)

        return { invoiceNumber: input.mark }
      },
    )

    const result = await stamped.run({ input: { mark: 'INV-4' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ invoiceNumber: 'INV-4', stamped: true })
    expect(firstRun(harness.runs).output).toEqual({ invoiceNumber: 'INV-4', stamped: true })
  })

  it('lets a workflow that declares no output return whatever it likes', async () => {
    const harness = createTestRuntime()

    const loose = defineWorkflow(
      { name: 'test.loose', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('issue'), input)

        return { anything: [input.mark] }
      },
    )

    const result = await loose.run({ input: { mark: 'INV-5' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ anything: ['INV-5'] })
  })
})
