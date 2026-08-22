import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  executeDurable,
  requestCancellation,
  WorkflowCancelledError,
  type DurableWorkflowHandle,
  type StepCall,
  type StepContext,
  type WorkflowHandle,
} from '../src/index'
import { createRetryingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// Which attempt this is, without the step having to count for itself. A provider that wants a
// DIFFERENT key per attempt — a few do, when a retry is meant to be a fresh request — can
// compose one; the default key stays stable so the common case is the safe one.
describe('a step knows which attempt it is on', () => {
  it('says one on the first', async () => {
    const harness = createTestRuntime()
    const seen: number[] = []

    const counting = createStep('count', {
      run: async (_input: { mark: string }, ctx: StepContext<TestRuntime>) => {
        seen.push(ctx.attempt)
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.attempt-one', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => wf.step(counting, input),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(seen).toEqual([1])
  })

  it('counts up as the platform retries', async () => {
    const harness = createTestRuntime()
    const seen: number[] = []

    const flaky = createStep('flaky', {
      run: async (_input: { mark: string }, ctx: StepContext<TestRuntime>) => {
        seen.push(ctx.attempt)
        if (ctx.attempt < 3) throw new Error('not yet')
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.attempt-many', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) =>
        wf.step(flaky, input),
    )

    await executeDurable(
      workflow,
      { runId: 'run_attempts', input: { mark: 'x' } },
      harness.ctx,
      createRetryingPrimitive({ attempts: 5 }),
    )

    expect(seen).toEqual([1, 2, 3])
  })

  // The key stays the key. An attempt-specific one is something the caller composes when they
  // want it, never something that changes under them.
  it('leaves the idempotency key alone across attempts', async () => {
    const harness = createTestRuntime()
    const keys: string[] = []

    const flaky = createStep('flaky-key', {
      run: async (_input: { mark: string }, ctx: StepContext<TestRuntime>) => {
        keys.push(ctx.idempotencyKey)
        if (ctx.attempt < 2) throw new Error('not yet')
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.attempt-key', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) =>
        wf.step(flaky, input),
    )

    await executeDurable(
      workflow,
      { runId: 'run_key', input: { mark: 'x' } },
      harness.ctx,
      createRetryingPrimitive({ attempts: 3 }),
    )

    expect(keys).toEqual(['run_key:0', 'run_key:0'])
  })
})

// An undo that knows WHY it is running can do a better job of it: a refund note that says
// "order cancelled by the customer" reads differently from one that says "the warehouse fell
// over", and a compensation that is undoing a cancellation may want to skip work a failure
// would have needed.
describe('a compensation is told why it is running', () => {
  it('is handed the failure that unwound the run', async () => {
    const harness = createTestRuntime()
    const causes: string[] = []

    const undoable = createStep('undoable', {
      run: async (input: { mark: string }) => ({ seen: input.mark }),
      compensate: async (_seen: { seen: string }, _ctx: StepContext<TestRuntime>, why) => {
        causes.push((why.cause as Error).message)
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.cause', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(undoable, input)
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(causes).toEqual(['boom refused'])
  })

  it('is handed the cancellation when that is the reason', async () => {
    const harness = createTestRuntime()
    const causes: unknown[] = []

    const undoable = createStep('undoable', {
      run: async (input: { mark: string }, ctx: StepContext<TestRuntime>) => {
        await requestCancellation({
          journal: ctx.journal,
          tenantId: ctx.tenantId,
          runId: ctx.runId,
        })

        return { seen: input.mark }
      },
      compensate: async (_seen: { seen: string }, _ctx: StepContext<TestRuntime>, why) => {
        causes.push(why.cause)
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.cause-cancel', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(undoable, input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(causes[0]).toBeInstanceOf(WorkflowCancelledError)
  })

  it('knows which attempt of the undo it is on', async () => {
    const harness = createTestRuntime()
    const attempts: number[] = []

    const undoable = createStep('undoable', {
      run: async (input: { mark: string }) => ({ seen: input.mark }),
      compensate: async (_seen: { seen: string }, ctx: StepContext<TestRuntime>) => {
        attempts.push(ctx.attempt)
        if (ctx.attempt < 2) throw new Error('the undo is flaky too')
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.undo-attempt', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(undoable, input)
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_undo', input: { mark: 'x' } },
      harness.ctx,
      createRetryingPrimitive({ attempts: 3 }),
    ).catch(() => undefined)

    expect(attempts).toEqual([1, 2])
  })
})

// A step call is awaited today and may become iterable in a later version, for bodies written
// as generators. Declaring the narrower contract now is what keeps that from being a breaking
// change.
describe('what a step call is', () => {
  it('is awaited, like a promise', async () => {
    const harness = createTestRuntime()
    let captured: StepCall<{ seen: string }> | null = null

    const workflow = defineWorkflow(
      { name: 'test.step-call', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        captured = wf.step(markStep('only'), input)

        return await captured
      },
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ seen: 'only:x' })
    expect(typeof (captured as unknown as PromiseLike<unknown>).then).toBe('function')
  })

  it('still works through Promise.all', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.step-call-all', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        Promise.all([wf.step(markStep('a'), input), wf.step(markStep('b'), input)]),
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.invocations).toEqual(['invoke:a', 'invoke:b'])
  })
})
