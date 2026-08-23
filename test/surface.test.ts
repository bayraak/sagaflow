import { describe, expect, it } from 'bun:test'

import { saga, sagaflow, step } from 'sagaflow-js'
import { createMemoryJournal, createMemorySink } from 'sagaflow-js/memory'
import { z } from 'zod'

// The README's first screen, compiled and run. If this is not the shortest honest way to write a
// saga, the surface is wrong.
describe('the seven-line example', () => {
  it('runs, and undoes itself when something refuses', async () => {
    const released: string[] = []
    const seats = {
      reserve: async (seat: string) => ({ id: `seat_${seat}`, price: 4200 }),
      release: async (id: string) => {
        released.push(id)
      },
    }
    const cards = { charge: async (_amount: number) => ({ chargeId: 'ch_1' }) }

    const flow = sagaflow({ warn: () => undefined })

    const createBooking = saga('booking.create', async (input: { seat: string }, s) => {
      const seat = await s.step(
        'reserve',
        () => seats.reserve(input.seat),
        (reserved) => seats.release(reserved.id),
      )
      await s.step('charge', () => cards.charge(seat.price))
      s.emit('booking.created', { seatId: seat.id })

      return seat
    })

    const booked = await createBooking({ seat: '12A' }, flow)

    expect(booked).toEqual({ id: 'seat_12A', price: 4200 })
    expect(released).toEqual([])
  })

  it('undoes the reservation when the charge refuses', async () => {
    const released: string[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const createBooking = saga('booking.create', async (input: { seat: string }, s) => {
      const seat = await s.step(
        'reserve',
        async () => ({ id: `seat_${input.seat}` }),
        (reserved) => {
          released.push(reserved.id)
        },
      )
      await s.step('charge', async () => {
        throw new Error('the card was declined')
      })

      return seat
    })

    const result = await createBooking.try({ seat: '12A' }, flow)

    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error).toMatchObject({
      outcome: 'compensated',
      failedStep: 'charge',
      compensated: ['reserve'],
    })
    expect(released).toEqual(['seat_12A'])
    expect(journal.runs[0]?.status).toBe('compensated')
  })
})

describe('configuring it once', () => {
  it('takes a journal, a sink and a scope', async () => {
    const journal = createMemoryJournal()
    const sink = createMemorySink()
    const flow = sagaflow({ journal: journal.journal, events: sink.sink })

    const write = saga('thing.write', async (input: { mark: string }, s) =>
      s.step('write', async () => ({ written: input.mark })),
    )

    await write({ mark: 'x' }, flow.for({ tenantId: 'acme', actor: 'tester' }))

    expect(journal.runs[0]).toMatchObject({ tenantId: 'acme', name: 'thing.write' })
    expect(sink.sent.every((event) => event.tenantId === 'acme')).toBe(true)
  })

  it('defaults the tenant', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const write = saga('thing.write', async (_input: { mark: string }, s) =>
      s.step('write', async () => 1),
    )

    await write({ mark: 'x' }, flow)

    expect(journal.runs[0]?.tenantId).toBe('default')
  })

  it('hands the scope extras to the body and its steps', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seen: unknown[] = []

    const write = saga('thing.write', async (_input: { mark: string }, s) => {
      seen.push(s.ctx())

      return s.step('write', async (stepContext) => {
        seen.push(stepContext.ctx)

        return 1
      })
    })

    await write({ mark: 'x' }, flow.for({ tenantId: 'acme', db: 'a-database-handle' }))

    expect(seen).toEqual([
      { tenantId: 'acme', actor: null, db: 'a-database-handle' },
      { db: 'a-database-handle' },
    ])
  })

  it('says once that nothing is durable when nothing was configured', async () => {
    const warnings: string[] = []
    const flow = sagaflow({ warn: (message) => warnings.push(message) })
    const write = saga('thing.write', async (_input: { mark: string }, s) =>
      s.step('write', async () => 1),
    )

    await write({ mark: 'a' }, flow)
    await write({ mark: 'b' }, flow)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not durable')
  })
})

describe('what a definition is', () => {
  const write = saga(
    'thing.write',
    { input: z.object({ mark: z.string().min(1) }), idempotent: true },
    async (input, s) => s.step('write', async () => ({ written: input.mark })),
  )

  it('knows its own name and how it runs', () => {
    expect(write.name).toBe('thing.write')
    expect(write.durable).toBe(false)
  })

  it('validates against the schema it was given', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })

    const result = await write.try({ mark: '' }, flow)

    expect(result.ok).toBe(false)
  })

  it('answers the same input twice with one run', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    await write({ mark: 'SAME' }, flow)
    await write({ mark: 'SAME' }, flow)

    expect(journal.runs).toHaveLength(1)
  })
})

describe('a reusable step', () => {
  it('is declared with step() and handed its input', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const undone: unknown[] = []

    // A reusable step is a plain function that calls the verb. There is no separate
    // constructor to learn.
    const reserve = (seat: string) =>
      step(
        'reserve',
        async () => ({ id: `seat_${seat}` }),
        async (reserved) => {
          undone.push(reserved)
        },
      )

    const book = saga('booking.reuse', async (input: { seat: string }) => {
      await reserve(input.seat)
      await step('boom', async () => {
        throw new Error('no')
      })
    })

    await book.try({ seat: '1A' }, flow)

    expect(undone).toEqual([{ id: 'seat_1A' }])
  })
})

describe('a durable definition', () => {
  const sendInvoice = saga(
    'invoice.send',
    {
      durable: true,
      idempotent: (input: { invoiceId: string }) => `invoice.send:${input.invoiceId}`,
    },
    async (input, s) => {
      await s.step('draft', async () => ({ drafted: input.invoiceId }))
      await s.sleep('grace', '3 days')
      await s.step('send', async () => ({ sent: true }))
    },
  )

  it('says it is durable', () => {
    expect(sendInvoice.durable).toBe(true)
  })

  it('is started through the configured launcher', async () => {
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

    const started = await sendInvoice.start({ invoiceId: 'INV-1' }, flow)

    expect(started.deduplicated).toBe(false)
    expect(journal.runs[0]).toMatchObject({ name: 'invoice.send', execution: 'durable' })
    expect(created).toHaveLength(1)
  })

  it('refuses to start without a launcher', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })

    expect(sendInvoice.start({ invoiceId: 'INV-2' }, flow)).rejects.toThrow('launcher')
  })
})

describe('the registry on the instance', () => {
  const write = saga('thing.write', async (input: { mark: string }, s) =>
    s.step('write', async () => ({ written: input.mark })),
  )

  it('dispatches by name', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal, sagas: [write] })

    const result = await flow.run('thing.write', { mark: 'x' })

    expect(result).toEqual({ written: 'x' })
  })

  it('says so when it does not know the name', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal, sagas: [write] })

    expect(flow.run('thing.missing', {})).rejects.toThrow('thing.missing')
  })

  it('cancels a run', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal, sagas: [write] })

    const runId = await journal.journal.insertRun({
      tenantId: 'default',
      name: 'thing.write',
      execution: 'durable',
      idempotencyKey: null,
      input: {},
    })

    expect(await flow.cancel(runId)).toBe(true)
  })
})
