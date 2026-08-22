import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  executeDurable,
  namedStep,
  type DurableWorkflowHandle,
  type WorkflowHandle,
} from '../src/index'
import { createRetryingPrimitive, passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

// A step that talks to somebody else's service is the reason this key exists: the provider
// accepted the charge, the acknowledgement was lost, the step is retried — and without a key
// that is stable across attempts, the customer is charged twice.
const keyReportingStep = (name: string, options: { failsUntilAttempt?: number } = {}) =>
  createStep<TestRuntime, { mark: string }, { key: string }, { key: string }>(
    name,
    async (_input, ctx) => {
      ctx.invocations.push(`invoke:${name}:${ctx.idempotencyKey}`)
      if (options.failsUntilAttempt !== undefined) {
        const seen = ctx.invocations.filter((entry) => entry.startsWith(`invoke:${name}:`)).length
        if (seen < options.failsUntilAttempt) throw new Error(`${name} refused`)
      }

      return { output: { key: ctx.idempotencyKey }, compensateWith: { key: ctx.idempotencyKey } }
    },
    async (_undo, ctx) => {
      ctx.invocations.push(`compensate:${name}:${ctx.idempotencyKey}`)
    },
  )

describe('every step context carries a key stable enough to hand a provider', () => {
  it('gives two attempts of one step the same key', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.retried', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(keyReportingStep('charge', { failsUntilAttempt: 2 }), input)
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_retry', input: { mark: 'x' } },
      harness.ctx,
      createRetryingPrimitive({ attempts: 3 }),
    )

    expect(harness.invocations).toEqual(['invoke:charge:run_retry:0', 'invoke:charge:run_retry:0'])
  })

  it('gives two steps different keys', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.two-steps', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(keyReportingStep('charge'), input)
        await wf.step(keyReportingStep('notify'), input)
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_two', input: { mark: 'x' } },
      harness.ctx,
      passThroughPrimitive(),
    )

    expect(harness.invocations).toEqual(['invoke:charge:run_two:0', 'invoke:notify:run_two:1'])
  })

  it('gives a fan-out one key per item', async () => {
    const harness = createTestRuntime()
    const send = keyReportingStep('send')

    const workflow = defineWorkflow(
      { name: 'test.fan-out', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        for (const recipient of ['a', 'b', 'c']) {
          await wf.step(namedStep(send, `send-${recipient}`), input)
        }
      },
    )

    await executeDurable(
      workflow,
      { runId: 'run_fan', input: { mark: 'x' } },
      harness.ctx,
      passThroughPrimitive(),
    )

    expect(harness.invocations).toEqual([
      'invoke:send:run_fan:0',
      'invoke:send:run_fan:1',
      'invoke:send:run_fan:2',
    ])
  })

  // Undoing a charge is a refund, not the charge again: it is a different side effect and must
  // not be handed the key that identifies the thing it is reversing.
  it('gives an undo a key of its own, derived from the step it reverses', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.undo-key', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(keyReportingStep('charge'), input)
        await wf.step(keyReportingStep('boom', { failsUntilAttempt: 99 }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.invocations).toContain('compensate:charge:run_1:0:undo')
  })
})
