import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { saga, sagaflow, SagaError, type WorkflowHandle } from '../src/index.js'
import { createMemoryJournal } from '../src/memory/index'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const failing = (options: { compensateFailsOn?: string } = {}) =>
  defineWorkflow(
    { name: 'test.try', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(
        markStep('first', { compensateFails: options.compensateFailsOn === 'first' }),
        input,
      )
      await wf.step(markStep('second'), input)
      await wf.step(markStep('boom', { fails: true }), input)
    },
  )

const succeeding = defineWorkflow(
  { name: 'test.try-ok', input: markInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
    wf.step('write', async () => ({ written: input.mark })),
)

// A failed saga is a normal outcome, not an exception in the "something is broken" sense — the
// undo ran, the record is written, and the caller has a decision to make. Making that decision
// should not require a try/catch and an instanceof.
describe('running a workflow without throwing', () => {
  it('answers with the output when it worked', async () => {
    const harness = createTestRuntime()

    const result = await succeeding.tryRun({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(result.ok).toBe(true)
    expect(result.ok && !result.deduplicated && result.output).toEqual({ written: 'x' })
  })

  it('answers with the trail when it did not', async () => {
    const harness = createTestRuntime()

    const result = await failing().tryRun({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(result).toMatchObject({
      ok: false,
      runId: 'run_1',
      outcome: 'compensated',
      failedStep: 'boom',
      compensated: ['second', 'first'],
      failedCompensations: [],
    })
    expect(result.ok ? null : (result.cause as Error).message).toBe('boom refused')
  })

  it('names the undos that themselves refused', async () => {
    const harness = createTestRuntime()

    const result = await failing({ compensateFailsOn: 'first' }).tryRun({
      input: { mark: 'x' },
      ctx: harness.ctx,
    })

    expect(result).toMatchObject({
      ok: false,
      outcome: 'failed',
      compensated: ['second'],
      failedCompensations: ['first'],
    })
  })

  it('answers rather than throws when the input is refused', async () => {
    const harness = createTestRuntime()

    const result = await succeeding.tryRun({ input: { mark: '' }, ctx: harness.ctx })

    expect(result).toMatchObject({ ok: false, runId: null, outcome: null })
  })

  it('is on a saga definition too', async () => {
    const memory = createMemoryJournal()
    const flow = sagaflow({ journal: memory.journal })
    const write = saga('thing.write', async (input: { mark: string }, s) =>
      s.step('write', async () => ({ written: input.mark })),
    )

    const result = await write.try({ mark: 'x' }, flow)

    expect(result.ok && !result.deduplicated && result.output).toEqual({ written: 'x' })
  })
})

// One source for the trail summary: whatever tryRun reports, the thrown error carries too.
describe('the error a failed run throws', () => {
  it('carries the same trail summary', async () => {
    const harness = createTestRuntime()

    const thrown = await failing({ compensateFailsOn: 'first' })
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SagaError)
    expect(thrown as SagaError).toMatchObject({
      outcome: 'failed',
      stepName: 'boom',
      compensated: ['second'],
      failedCompensations: ['first'],
    })
  })
})
