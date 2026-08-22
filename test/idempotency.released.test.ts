import { describe, expect, it } from 'bun:test'

import { defineWorkflow, type WorkflowHandle } from '../src/index'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const sendInvoice = (options: { fails?: boolean } = {}) => {
  const send = markStep('send', { fails: options.fails })

  return defineWorkflow(
    {
      name: 'invoice.send',
      input: markInput,
      execution: 'inline',
      idempotency: (input) => `invoice.send:${input.mark}`,
    },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      const sent = await wf.step(send, input)

      return { finished: sent.seen }
    },
  )
}

// A key held forever by a run that FAILED is a door that locks behind you: an invoice whose
// send fell over could never be sent again, and the caller asking a second time was told
// `deduplicated: true, status: 'failed'` — an answer that reads like success and is not.
describe('an idempotency key is held by a run that is still standing, not by one that fell over', () => {
  it('lets the same key run again after the first run compensated', async () => {
    const { ctx, invocations, runs } = createTestRuntime()

    await sendInvoice({ fails: true })
      .run({ input: { mark: 'INV-1' }, ctx })
      .catch(() => undefined)

    const second = await sendInvoice().run({ input: { mark: 'INV-1' }, ctx })

    expect(second.deduplicated).toBe(false)
    expect(invocations).toEqual(['invoke:send', 'invoke:send'])
    expect(runs.map((run) => run.status)).toEqual(['compensated', 'completed'])
  })

  it('still refuses a key a completed run holds', async () => {
    const { ctx, invocations } = createTestRuntime()

    await sendInvoice().run({ input: { mark: 'INV-2' }, ctx })
    const second = await sendInvoice().run({ input: { mark: 'INV-2' }, ctx })

    expect(second.deduplicated).toBe(true)
    expect(invocations).toEqual(['invoke:send'])
  })

  it('still refuses a key a running run holds', async () => {
    const { ctx, journal } = createTestRuntime()

    const runId = await journal.insertRun({
      tenantId: 'tenant_local',
      name: 'invoice.send',
      execution: 'durable',
      idempotencyKey: 'invoice.send:INV-3',
      input: { mark: 'INV-3' },
    })

    const second = await sendInvoice().run({ input: { mark: 'INV-3' }, ctx })

    expect(second).toEqual({ runId, output: undefined, status: 'running', deduplicated: true })
  })

  it('answers with the held run when a released one carries the same key', async () => {
    const { ctx } = createTestRuntime()

    await sendInvoice({ fails: true })
      .run({ input: { mark: 'INV-4' }, ctx })
      .catch(() => undefined)
    const completed = await sendInvoice().run({ input: { mark: 'INV-4' }, ctx })
    const third = await sendInvoice().run({ input: { mark: 'INV-4' }, ctx })

    expect(third.runId).toBe(completed.runId)
    expect(third.deduplicated && third.status).toBe('completed')
  })
})
