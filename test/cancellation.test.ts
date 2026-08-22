import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  requestCancellation,
  WorkflowCancelledError,
  WorkflowError,
  type WorkflowHandle,
} from '../src/index'
import { createTestRuntime, firstRun, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// Somebody asking for the run to stop, from outside it. Doing it from inside a step is how a
// suite makes "the request arrived between two steps" happen at a known moment.
const cancellingStep = (name: string, options: { compensateFails?: boolean } = {}) =>
  createStep<TestRuntime, { mark: string }, { seen: string }, { undo: string }>(name, {
    run: async (input, ctx) => {
      ctx.invocations.push(`invoke:${name}`)
      await requestCancellation({ journal: ctx.journal, tenantId: ctx.tenantId, runId: ctx.runId })

      return { output: { seen: input.mark }, compensateWith: { undo: name } }
    },
    compensate: async (undo, ctx) => {
      ctx.invocations.push(`compensate:${undo.undo}`)
      if (options.compensateFails) throw new Error(`${name} could not be undone`)
    },
  })

const cancellable = (options: { compensateFails?: boolean } = {}) =>
  defineWorkflow(
    { name: 'test.cancellable', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(cancellingStep('first', options), input)
      await wf.step(markStep('second'), input)

      return { finished: input.mark }
    },
  )

// Cancellation is cooperative and takes effect at the next step boundary. A step already
// running is not interrupted — the library has no way to interrupt somebody else's code, and
// pretending otherwise would be the dangerous kind of promise.
describe('a run can be asked to stop', () => {
  it('runs no further step once the request has arrived', async () => {
    const harness = createTestRuntime()

    await cancellable()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.invocations).toEqual(['invoke:first', 'compensate:first'])
  })

  it('undoes what the run had already done', async () => {
    const harness = createTestRuntime()

    await cancellable()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.steps.map((step) => [step.name, step.status])).toEqual([
      ['first', 'completed'],
      ['compensate:first', 'compensated'],
    ])
  })

  it('closes the run as cancelled when the undo was complete', async () => {
    const harness = createTestRuntime()

    await cancellable()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(firstRun(harness.runs).status).toBe('cancelled')
  })

  // Cancelled is not a euphemism for tidy: if something the run did could not be reversed, the
  // run failed, and calling it cancelled would tell a reader the tenant was left whole.
  it('closes the run as failed when an undo refused', async () => {
    const harness = createTestRuntime()

    await cancellable({ compensateFails: true })
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(firstRun(harness.runs).status).toBe('failed')
  })

  it('tells the caller the run was cancelled rather than that it broke', async () => {
    const harness = createTestRuntime()

    const thrown = await cancellable()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(thrown instanceof WorkflowError && thrown.outcome).toBe('cancelled')
    expect(thrown instanceof WorkflowError && thrown.cause).toBeInstanceOf(WorkflowCancelledError)
  })

  it('announces the cancellation as the way the run ended', async () => {
    const harness = createTestRuntime()

    await cancellable()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
    expect(harness.outbox[0]?.payload).toMatchObject({ outcome: 'cancelled' })
  })

  it('drops what the body emitted, as any run that did not happen does', async () => {
    const harness = createTestRuntime()

    const emitting = defineWorkflow(
      { name: 'test.cancellable-emitting', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        wf.emit('invoice.voided', { invoiceId: input.mark })
        await wf.step(cancellingStep('first'), input)
        await wf.step(markStep('second'), input)
      },
    )

    await emitting.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
  })
})

describe('asking a run to stop', () => {
  it('is accepted by a run that is still running', async () => {
    const { journal } = createTestRuntime()

    const runId = await journal.insertRun({
      tenantId: 'tenant_local',
      name: 'test.long',
      execution: 'durable',
      idempotencyKey: null,
      input: {},
    })

    expect(await requestCancellation({ journal, tenantId: 'tenant_local', runId })).toBe(true)
  })

  it('is refused by a run that has already finished', async () => {
    const harness = createTestRuntime()

    const result = await cancellable()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(result).toBeUndefined()
    expect(
      await requestCancellation({
        journal: harness.journal,
        tenantId: 'tenant_local',
        runId: firstRun(harness.runs).id,
      }),
    ).toBe(false)
  })

  it('is refused for a run nobody has heard of', async () => {
    const { journal } = createTestRuntime()

    expect(
      await requestCancellation({ journal, tenantId: 'tenant_local', runId: 'run_nowhere' }),
    ).toBe(false)
  })

  it('is refused for the same run in another tenant', async () => {
    const { journal } = createTestRuntime()

    const runId = await journal.insertRun({
      tenantId: 'tenant_local',
      name: 'test.long',
      execution: 'durable',
      idempotencyKey: null,
      input: {},
    })

    expect(await requestCancellation({ journal, tenantId: 'tenant_other', runId })).toBe(false)
  })
})
