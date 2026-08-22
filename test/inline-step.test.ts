import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  executeDurable,
  WorkflowError,
  type DurableWorkflowHandle,
  type StepContext,
  type WorkflowHandle,
} from '../src/index'
import { createFakePrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// Most steps are used once, in one body, and lifting them out to be declared separately buys
// nothing but distance between the work and the reason for it. The inline form puts them back
// where they are used — and goes down exactly the same engine path, so it is not a second
// weaker way of doing things.
describe('a step declared where it is used', () => {
  it('runs and returns its value', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.inline-step', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step('reserve', async () => ({ number: `N-${input.mark}` })),
    )

    const result = await workflow.run({ input: { mark: '7' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ number: 'N-7' })
  })

  it('is recorded like any other step', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.inline-recorded', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('one', async () => 1)
        await wf.step('two', async () => 2)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.steps.map((step) => [step.seq, step.name, step.status])).toEqual([
      [0, 'one', 'completed'],
      [1, 'two', 'completed'],
    ])
  })

  it('is handed the same context every other step gets', async () => {
    const harness = createTestRuntime()
    const seen: { runId: string; key: string; attempt: number }[] = []

    const workflow = defineWorkflow(
      { name: 'test.inline-context', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('look', async (ctx) => {
          seen.push({ runId: ctx.runId, key: ctx.idempotencyKey, attempt: ctx.attempt })
        })
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(seen).toEqual([{ runId: 'run_1', key: 'run_1:0', attempt: 1 }])
  })

  it('carries its own undo and its own budget', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive()
    const undone: unknown[] = []

    const workflow = defineWorkflow(
      { name: 'test.inline-undo', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step('charge', async () => ({ chargeId: `ch-${input.mark}` }), {
          compensate: async (charged) => {
            undone.push(charged)
          },
          retries: { limit: 1, delay: '1 second' },
        })
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_inline', input: { mark: 'x' } },
      harness.ctx,
      primitive,
    ).catch(() => undefined)

    expect(undone).toEqual([{ chargeId: 'ch-x' }])
    expect(calls.find((call) => call.name === 'charge')?.config).toEqual({
      retries: { limit: 1, delay: '1 second' },
    })
  })

  it('obeys the reserved names', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.inline-reserved', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('finish-run', async () => 1)
      },
    )

    const thrown = await workflow
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(((thrown as WorkflowError).cause as Error).message).toContain('reserved')
  })

  it('obeys the one-name-per-run rule', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.inline-duplicate', input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('twice', async () => 1)
        await wf.step('twice', async () => 2)
      },
    )

    const thrown = await workflow
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(((thrown as WorkflowError).cause as Error).message).toContain('already used in this run')
  })
})

// One rule, not two: the compensation is handed exactly what the step returned. A step that
// needs something extra to undo itself returns it, and then its value says everything about what
// it did — which is also what the run record ends up holding.
describe('what a compensation is handed', () => {
  it('is what the step returned, declared inline', async () => {
    const harness = createTestRuntime()
    const undone: unknown[] = []

    const workflow = defineWorkflow(
      { name: 'test.undo-inline', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('reserve', async () => ({ number: 41, ledger: 'main' }), {
          compensate: async (reserved) => {
            undone.push(reserved)
          },
        })
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(undone).toEqual([{ number: 41, ledger: 'main' }])
  })

  it('is what the step returned, declared separately', async () => {
    const harness = createTestRuntime()
    const undone: unknown[] = []

    const reserve = createStep('reserve', {
      run: async (input: { mark: string }) => ({ number: 41, mark: input.mark }),
      compensate: async (reserved: { number: number; mark: string }) => {
        undone.push(reserved)
      },
    })

    const workflow = defineWorkflow(
      { name: 'test.undo-separate', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(reserve, input)
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(undone).toEqual([{ number: 41, mark: 'x' }])
  })

  // The receipt is the whole point: a step returns what it did, the body uses it, the undo uses
  // it, and the run record holds it. One value, three readers.
  it('is the receipt the body itself was given', async () => {
    const harness = createTestRuntime()
    const undone: unknown[] = []
    const usedByBody: { chargeId: string }[] = []

    const workflow = defineWorkflow(
      { name: 'test.undo-receipt', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        const receipt = await wf.step('charge', async () => ({ chargeId: `ch-${input.mark}` }), {
          compensate: async (charged) => {
            undone.push(charged)
          },
        })
        usedByBody.push(receipt)
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(usedByBody).toEqual([{ chargeId: 'ch-x' }])
    expect(undone).toEqual(usedByBody)
    expect(harness.steps[0]?.output).toEqual({ chargeId: 'ch-x' })
  })

  it('does not run at all when the step declared no undo', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.undo-none', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('write', async () => ({ written: true }))
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.steps.map((step) => step.name)).toEqual(['write', 'boom'])
  })

  it('is told why, inline as well', async () => {
    const harness = createTestRuntime()
    const causes: string[] = []

    const workflow = defineWorkflow(
      { name: 'test.undo-inline-cause', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step('reserve', async () => 1, {
          compensate: async (_value: number, _ctx: StepContext<TestRuntime>, why) => {
            causes.push((why.cause as Error).message)
          },
        })
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(causes).toEqual(['boom refused'])
  })
})
