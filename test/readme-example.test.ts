import { describe, expect, it } from 'bun:test'

import {
  createStep,
  defineWorkflow,
  executeDurable,
  WorkflowError,
  type StepPrimitive,
} from 'sagaflow'
import { createMemoryJournal, createMemorySink } from 'sagaflow/memory'
import { z } from 'zod'

// Every example in the README lives here, compiled and run, so the first thing a reader
// copies is the thing the suite proves. Keep the two in step: if you change one, change both.

describe('README: the sixty-second example', () => {
  it('runs, undoes itself, and says what happened', async () => {
    // --- your application ---------------------------------------------------
    const issued: number[] = []
    const nextInvoiceNumber = async () => {
      issued.push(issued.length + 1)

      return issued.at(-1) as number
    }
    const releaseInvoiceNumber = async (number: number) => {
      issued.splice(issued.indexOf(number), 1)
    }
    // ------------------------------------------------------------------------

    const reserveNumber = createStep('reserve-number', {
      run: async (_input: { customerId: string }) => nextInvoiceNumber(),
      compensate: async (number) => releaseInvoiceNumber(number),
    })

    const createInvoice = defineWorkflow(
      {
        name: 'invoice.create',
        input: z.object({ customerId: z.string() }),
        execution: 'inline',
      },
      async (input, wf) => {
        const number = await wf.step(reserveNumber, input)
        wf.emit('invoice.created', { customerId: input.customerId, number })

        return { number }
      },
    )

    const { journal } = createMemoryJournal()
    const { sink } = createMemorySink()

    const result = await createInvoice.run({
      input: { customerId: 'cus_1' },
      ctx: { tenantId: 'acme', journal, events: sink },
    })

    expect(result.deduplicated).toBe(false)
    expect(!result.deduplicated && result.output).toEqual({ number: 1 })
    expect(issued).toEqual([1])
  })
})

describe('README: compensation leaves a trail', () => {
  it('undoes in reverse and records every leg of it', async () => {
    const charged: string[] = []
    const refunded: string[] = []

    const charge = createStep('charge-card', {
      run: async (_input: { customerId: string; amount: number }, ctx) => {
        charged.push(ctx.idempotencyKey)

        return { chargeId: 'ch_1' }
      },
      compensate: async (receipt) => {
        refunded.push(receipt.chargeId)
      },
    })

    const ship = createStep('ship-order', {
      run: async () => {
        throw new Error('out of stock')
      },
    })

    const placeOrder = defineWorkflow(
      {
        name: 'order.place',
        input: z.object({ customerId: z.string(), amount: z.number() }),
        execution: 'inline',
      },
      async (input, wf) => {
        await wf.step(charge, input)
        await wf.step(ship, input)

        return { placed: true }
      },
    )

    const { journal, runs, steps } = createMemoryJournal()

    const failure = await placeOrder
      .run({
        input: { customerId: 'cus_1', amount: 4200 },
        ctx: { tenantId: 'acme', journal },
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkflowError)
    expect(refunded).toEqual(['ch_1'])
    expect(runs[0]?.status).toBe('compensated')
    expect(steps.map((step) => [step.name, step.status])).toEqual([
      ['charge-card', 'completed'],
      ['ship-order', 'failed'],
      ['compensate:charge-card', 'compensated'],
    ])
    // The charge saw a key it will see again on every retry and every replay of that step.
    expect(charged).toEqual([`${runs[0]?.id}:0`])
  })
})

describe('README: the same request asked twice', () => {
  it('does the work once and answers the second caller with the first result', async () => {
    let sent = 0

    const send = createStep('send-email', {
      run: async () => {
        sent += 1
      },
    })

    const sendReceipt = defineWorkflow(
      {
        name: 'receipt.send',
        input: z.object({ invoiceId: z.string() }),
        execution: 'inline',
        idempotency: (input) => `receipt.send:${input.invoiceId}`,
      },
      async (input, wf) => {
        await wf.step(send, input)

        return { sent: input.invoiceId }
      },
    )

    const { journal } = createMemoryJournal()
    const ctx = { tenantId: 'acme', journal }

    const first = await sendReceipt.run({ input: { invoiceId: 'inv_1' }, ctx })
    const second = await sendReceipt.run({ input: { invoiceId: 'inv_1' }, ctx })

    expect(sent).toBe(1)
    expect(second.deduplicated).toBe(true)
    expect(second.runId).toBe(first.runId)
    expect(second.output).toEqual({ sent: 'inv_1' })
  })
})

describe('README: a durable workflow that waits', () => {
  it('sleeps, waits for a signal, and is driven in a test by a fake platform', async () => {
    const reminded: string[] = []

    const remind = createStep('send-reminder', {
      run: async (input: { invoiceId: string }) => {
        reminded.push(input.invoiceId)
      },
    })

    const chase = defineWorkflow(
      {
        name: 'invoice.chase',
        input: z.object({ invoiceId: z.string() }),
        execution: 'durable',
      },
      async (input, wf) => {
        await wf.sleep('grace-period', '7 days')
        const paid = await wf.waitForEvent<{ paid: boolean }>('payment', {
          type: 'invoice.paid',
          timeout: '30 days',
        })

        if (paid.paid) return { chased: false }

        await wf.step(remind, input)

        return { chased: true }
      },
    )

    // The testing recipe from the README: a StepPrimitive that just runs the body drives a
    // durable definition with no platform at all.
    const platform: StepPrimitive = {
      do: async (_name, _config, run) => run({ attempt: 1 }),
      sleep: async () => undefined,
      waitForEvent: async () => ({ paid: false }) as never,
    }

    const { journal } = createMemoryJournal()

    const output = await executeDurable(
      chase,
      { runId: 'run_1', input: { invoiceId: 'inv_1' } },
      { tenantId: 'acme', journal },
      platform,
    )

    expect(output).toEqual({ chased: true })
    expect(reminded).toEqual(['inv_1'])
  })
})
