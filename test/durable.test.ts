import { describe, expect, it } from 'bun:test'

import {
  defineWorkflow,
  executeDurable,
  WorkflowError,
  type DurableWorkflowHandle,
  type StepPrimitive,
  type StepRetryConfig,
} from '../src/index'
import { createFakePrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const durableWorkflow = (options: { config?: StepRetryConfig; failOn?: string } = {}) => {
  const first = markStep('first', { config: options.config })
  const second = markStep('second', { fails: options.failOn === 'second' })

  return defineWorkflow(
    { name: 'test.durable', input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
      await wf.step(first, input)
      await wf.sleep('settle', '1 minute')
      const ack = await wf.waitForEvent<{ ok: boolean }>('acknowledged', { type: 'ack' })
      await wf.step(second, input)
      wf.emit('invoice.voided', { invoiceId: input.mark })

      return { acknowledged: ack.ok }
    },
  )
}

const durableRun = async (
  workflow: ReturnType<typeof durableWorkflow>,
  harness: ReturnType<typeof createTestRuntime>,
  primitive: StepPrimitive,
) =>
  executeDurable(
    workflow,
    { runId: 'run_given', input: { mark: 'x' } },
    harness.ctx,
    primitive,
  ).catch((error: unknown) => error)

describe('the durable executor drives the same body through step primitives', () => {
  it('runs each step through the primitive', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(harness.invocations).toEqual(['invoke:first', 'invoke:second'])
    expect(calls.filter((call) => call.kind === 'do').map((call) => call.name)).toEqual([
      'first',
      'second',
      'emit-events',
    ])
  })

  it('names each primitive step after the step', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(calls.map((call) => `${call.kind}:${call.name}`)).toEqual([
      'do:first',
      'sleep:settle',
      'waitForEvent:acknowledged',
      'do:second',
      'do:emit-events',
    ])
  })

  it('passes the step retry config through', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })
    const config: StepRetryConfig = {
      retries: { limit: 7, delay: '3 seconds', backoff: 'linear' },
      timeout: '30 seconds',
    }

    await durableRun(durableWorkflow({ config }), harness, primitive)

    expect(calls.find((call) => call.name === 'first')?.config).toEqual(config)
  })

  it('defaults the retry config when none is declared', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    const applied = calls.find((call) => call.name === 'second')?.config

    expect(applied?.retries?.limit).toBeGreaterThan(0)
    expect(typeof applied?.timeout).toBe('string')
  })

  it('records the attempt the primitive reports', async () => {
    const harness = createTestRuntime()
    const { primitive } = createFakePrimitive({ event: { ok: true }, attempt: 3 })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(harness.steps.map((step) => step.attempt)).toEqual([3, 3])
  })

  it('passes a sleep straight through', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(calls.find((call) => call.kind === 'sleep')?.detail).toBe('1 minute')
  })

  it('passes a waited-for event straight through', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(calls.find((call) => call.kind === 'waitForEvent')?.detail).toEqual({ type: 'ack' })
  })

  it('records steps against the run it was given', async () => {
    const harness = createTestRuntime()
    const { primitive } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(harness.steps.every((step) => step.runId === 'run_given')).toBe(true)
  })

  it('never opens a second run record', async () => {
    const harness = createTestRuntime()
    const { primitive } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(harness.runs).toEqual([])
  })

  it('compensates inside the primitive on failure', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow({ failOn: 'second' }), harness, primitive)

    expect(calls.filter((call) => call.kind === 'do').map((call) => call.name)).toEqual([
      'first',
      'second',
      'compensate:first',
    ])
  })

  it('compensates backwards like the inline executor', async () => {
    const harness = createTestRuntime()
    const { primitive } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow({ failOn: 'second' }), harness, primitive)

    expect(harness.invocations).toEqual(['invoke:first', 'invoke:second', 'compensate:first'])
  })

  it('closes the durable run as compensated', async () => {
    const harness = createTestRuntime()
    const { primitive } = createFakePrimitive({ event: { ok: true } })

    const thrown = await durableRun(durableWorkflow({ failOn: 'second' }), harness, primitive)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(harness.steps.find((step) => step.name === 'compensate:first')?.status).toBe(
      'compensated',
    )
    expect(harness.finishes).toEqual([
      {
        runId: 'run_given',
        status: 'compensated',
        output: undefined,
        error: 'second refused',
        // A compensated run never happened, so it hands nothing the body emitted over to be
        // delivered.
        events: [],
      },
    ])
  })

  it('flushes its events through a primitive step', async () => {
    const harness = createTestRuntime()
    const { primitive, calls } = createFakePrimitive({ event: { ok: true } })

    await durableRun(durableWorkflow(), harness, primitive)

    expect(calls.at(-1)?.name).toBe('emit-events')
    expect(harness.sent.map((message) => message.type)).toEqual([
      'invoice.voided',
      'workflow.completed',
    ])
  })
})
