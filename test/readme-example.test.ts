import { describe, expect, it } from 'bun:test'

import { emit, saga, sagaflow, sleep, step, waitForEvent } from 'sagaflow'
import { createMemoryJournal, createMemorySink } from 'sagaflow/memory'
import { z } from 'zod'

// Every example in the README lives here, compiled and run, so the first thing a reader copies
// is the thing the suite proves. Keep the two in step: if you change one, change both.

describe('README: the first screen', () => {
  const seats = {
    released: [] as string[],
    reserve: async (seat: string) => ({ id: `seat_${seat}`, price: 4200 }),
    release: async (id: string) => {
      seats.released.push(id)
    },
  }
  const cards = { charge: async (amount: number) => ({ chargeId: `ch_${amount}` }) }

  const createBooking = saga('booking.create', async (input: { seat: string }) => {
    const seat = await step(
      'reserve',
      () => seats.reserve(input.seat),
      (reserved) => seats.release(reserved.id),
    )
    await step('charge', () => cards.charge(seat.price))
    await emit('booking.created', { seatId: seat.id })

    return seat
  })

  it('runs', async () => {
    const journal = createMemoryJournal()
    const sink = createMemorySink()
    const flow = sagaflow({ journal: journal.journal, events: sink.sink })

    const booked = await createBooking({ seat: '12A' }, flow)

    expect(booked).toEqual({ id: 'seat_12A', price: 4200 })
    expect(journal.runs[0]).toMatchObject({ name: 'booking.create', status: 'completed' })
    expect(sink.sent.map((event) => event.type)).toEqual(['booking.created', 'workflow.completed'])
  })
})

describe('README: undoing leaves a trail', () => {
  it('undoes in reverse and records every leg of it', async () => {
    const refunded: string[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const placeOrder = saga(
      'order.place',
      { input: z.object({ customerId: z.string(), amount: z.number() }) },
      async (_input) => {
        await step(
          'charge-card',
          // ctx.idempotencyKey is the same on every attempt and every replay of this step. Hand
          // it to your provider's idempotency header and a retry stops being a second charge.
          async (ctx) => ({ chargeId: `ch_${ctx.idempotencyKey}` }),
          (receipt) => {
            refunded.push(receipt.chargeId)
          },
        )
        await step('ship-order', async () => {
          throw new Error('out of stock')
        })

        return { placed: true }
      },
    )

    const result = await placeOrder.try({ customerId: 'cus_1', amount: 4200 }, flow)

    expect(result).toMatchObject({
      ok: false,
      outcome: 'compensated',
      failedStep: 'ship-order',
      compensated: ['charge-card'],
    })
    expect(refunded).toEqual([`ch_${journal.runs[0]?.id}:0`])
    expect(journal.steps.map((row) => [row.name, row.status])).toEqual([
      ['charge-card', 'completed'],
      ['ship-order', 'failed'],
      ['compensate:charge-card', 'compensated'],
    ])
  })
})

describe('README: the same request asked twice', () => {
  it('does the work once and answers the second caller with the first result', async () => {
    let sent = 0
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const sendReceipt = saga(
      'receipt.send',
      { input: z.object({ invoiceId: z.string() }), idempotent: true },
      async (input) => {
        await step('send-email', async () => {
          sent += 1
        })

        return { sent: input.invoiceId }
      },
    )

    await sendReceipt({ invoiceId: 'inv_1' }, flow)
    await sendReceipt({ invoiceId: 'inv_1' }, flow)

    expect(sent).toBe(1)
    expect(journal.runs).toHaveLength(1)
  })
})

describe('README: a durable saga that waits', () => {
  it('is declared with durable: true and started, not called', async () => {
    const journal = createMemoryJournal()
    const created: unknown[] = []
    const flow = sagaflow({
      journal: journal.journal,
      launcher: {
        create: async (instance) => {
          created.push(instance)

          return { id: instance.id ?? 'x' }
        },
      },
    })

    const chaseInvoice = saga(
      'invoice.chase',
      { input: z.object({ invoiceId: z.string() }), durable: true },
      async (input) => {
        await sleep('grace-period', '7 days')
        const paid = await waitForEvent<{ paid: boolean }>('payment', {
          type: 'invoice.paid',
          timeout: '30 days',
        })

        if (paid.paid) return { chased: false }

        await step('send-reminder', async () => ({ reminded: input.invoiceId }))

        return { chased: true }
      },
    )

    const started = await chaseInvoice.start({ invoiceId: 'inv_1' }, flow)

    expect(started.deduplicated).toBe(false)
    expect(journal.runs[0]).toMatchObject({ name: 'invoice.chase', execution: 'durable' })
    expect(created).toHaveLength(1)
  })
})

describe('README: a saga inside a saga', () => {
  it('joins the caller rather than opening a second run', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const chargeCard = saga('charge', async (input: { amount: number }) => {
      await step('authorise', async () => ({ chargeId: `ch_${input.amount}` }))

      return step('capture', async () => ({ captured: true }))
    })

    const placeOrder = saga('order.place-nested', async () => {
      await step('reserve', async () => ({ id: 'seat_1' }))

      return chargeCard({ amount: 4200 })
    })

    await placeOrder(undefined, flow)

    expect(journal.runs).toHaveLength(1)
    expect(journal.steps.map((row) => row.name)).toEqual([
      'reserve',
      'charge/authorise',
      'charge/capture',
    ])
  })
})
