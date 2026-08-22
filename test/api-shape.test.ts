import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defaultStepConfig,
  defineWorkflow,
  requestCancellation,
  SagaflowError,
  SchemaError,
  WorkflowCancelledError,
  WorkflowError,
  type StepContext,
  type WorkflowHandle,
} from '../src/index'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// A list of positional arguments is where a signature stops being able to grow: the next thing
// anybody wants from a step has nowhere to go that is not a fifth argument. Everything except
// the name is an options bag, so a new key is an additive change that breaks nobody.
describe('a step is a name and a bag of options', () => {
  it('takes its work, its undo and its budget as keys', async () => {
    const harness = createTestRuntime()

    const reserve = createStep('reserve', {
      run: async (input: { mark: string }, ctx: StepContext<TestRuntime>) => {
        ctx.invocations.push('invoke:reserve')

        return { output: { seen: input.mark }, compensateWith: { undo: 'reserve' } }
      },
      compensate: async (undo: { undo: string }, ctx: StepContext<TestRuntime>) => {
        ctx.invocations.push(`compensate:${undo.undo}`)
      },
      retries: { limit: 1, delay: '1 second' },
      timeout: '30 seconds',
    })

    const workflow = defineWorkflow(
      { name: 'test.options-step', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => wf.step(reserve, input),
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ seen: 'x' })
    expect(reserve.config).toEqual({
      retries: { limit: 1, delay: '1 second' },
      timeout: '30 seconds',
    })
    expect(harness.invocations).toEqual(['invoke:reserve'])
  })

  it('spends the default budget when it names none', () => {
    const step = createStep('plain', { run: async () => ({ output: 1 }) })

    expect(step.config).toEqual(defaultStepConfig)
  })

  it('spends only what it named when it names one', () => {
    const step = createStep('impatient', {
      run: async () => ({ output: 1 }),
      timeout: '5 seconds',
    })

    expect(step.config).toEqual({ timeout: '5 seconds' })
  })

  it('refuses a reserved name', () => {
    expect(() => createStep('finish-run', { run: async () => ({ output: 1 }) })).toThrow('reserved')
  })
})

// One `catch` for anything this library threw. Without a shared ancestor a caller has to know
// every concrete name, and every error type added later silently walks past the catch block
// somebody wrote carefully.
describe('everything this library throws shares an ancestor', () => {
  it('covers a refused input', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.base-input', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(markStep('a'), input),
    )

    const thrown = await workflow
      .run({ input: { mark: '' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(SchemaError)
    expect(thrown).toBeInstanceOf(SagaflowError)
  })

  it('covers a failed run', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.base-failure', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(markStep('a', { fails: true }), input),
    )

    const thrown = await workflow
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(thrown).toBeInstanceOf(SagaflowError)
  })

  it('covers a cancellation', async () => {
    const harness = createTestRuntime()

    const cancelling = createStep('cancel-me', {
      run: async (input: { mark: string }, ctx: StepContext<TestRuntime>) => {
        await requestCancellation({
          journal: ctx.journal,
          tenantId: ctx.tenantId,
          runId: ctx.runId,
        })

        return { output: { seen: input.mark } }
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.base-cancel', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(cancelling, input),
    )

    const thrown = await workflow
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect((thrown as WorkflowError).cause).toBeInstanceOf(WorkflowCancelledError)
    expect((thrown as WorkflowError).cause).toBeInstanceOf(SagaflowError)
  })
})
