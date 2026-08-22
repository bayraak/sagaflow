import { describe, expect, it } from 'bun:test'

import { all, ctx, emit, runId, saga, sagaflow, step } from 'sagaflow'
import { createMemoryJournal, createMemorySink } from 'sagaflow/memory'

// The README's first screen. No handle, no instance argument, no ceremony — the verbs are
// imported and they know which saga they are in.
describe('the seven-line example', () => {
  const seats = {
    reserve: async (seat: string) => ({ id: `seat_${seat}`, price: 4200 }),
    released: [] as string[],
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
    emit('booking.created', { seatId: seat.id })

    return seat
  })

  it('runs with no instance at all', async () => {
    const booked = await createBooking({ seat: '12A' })

    expect(booked).toEqual({ id: 'seat_12A', price: 4200 })
  })

  it('runs against a configured instance when given one', async () => {
    const journal = createMemoryJournal()
    const sink = createMemorySink()
    const flow = sagaflow({ journal: journal.journal, events: sink.sink })

    await createBooking({ seat: '1B' }, flow)

    expect(journal.runs[0]).toMatchObject({ name: 'booking.create', status: 'completed' })
    expect(journal.steps.map((row) => row.name)).toEqual(['reserve', 'charge'])
    expect(sink.sent.map((event) => event.type)).toEqual(['booking.created', 'workflow.completed'])
  })
})

describe('the verbs', () => {
  it('refuse to work outside a saga', () => {
    expect(() => step('nowhere', async () => 1)).toThrow('outside a saga')
    expect(() => emit('nowhere', {})).toThrow('outside a saga')
    expect(() => runId()).toThrow('outside a saga')
    expect(() => ctx()).toThrow('outside a saga')
  })

  it('know the run they are in', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seen: string[] = []

    const look = saga('thing.look', async () => {
      seen.push(runId())

      return step('inner', async (stepContext) => {
        seen.push(stepContext.runId, stepContext.idempotencyKey, String(stepContext.attempt))
      })
    })

    await look(undefined, flow)

    expect(seen).toEqual(['run_1', 'run_1', 'run_1:0', '1'])
  })

  it('read the scope the instance was given', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal }).for({
      tenantId: 'acme',
      actor: 'tester',
      db: 'a-handle',
    })
    const seen: unknown[] = []

    const look = saga('thing.scope', async () => {
      seen.push(ctx())
    })

    await look(undefined, flow)

    expect(seen).toEqual([{ tenantId: 'acme', actor: 'tester', db: 'a-handle' }])
  })

  it('group work with all()', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const fan = saga('thing.fan', async () =>
      all('fan-out', [() => step('a', async () => 'a'), () => step('b', async () => 'b')]),
    )

    expect(await fan(undefined, flow)).toEqual(['a', 'b'])
  })

  it('do not leak between concurrent runs', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const slow = saga('thing.slow', async () =>
      step('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))

        return runId()
      }),
    )
    const quick = saga('thing.quick', async () => step('quick', async () => runId()))

    const [a, b] = await Promise.all([slow(undefined, flow), quick(undefined, flow)])

    expect(a).not.toBe(b)
    expect(journal.steps.map((row) => [row.runId, row.name]).toSorted()).toEqual(
      [
        [a as string, 'slow'],
        [b as string, 'quick'],
      ].toSorted(),
    )
  })
})

// A saga called from inside another saga is not a second run. Its steps join the caller's trail
// under its own name, its undos join the caller's chain, and its events are held with the
// caller's — which is what somebody writing `await chargeCard(input)` in a body already assumes.
describe('a saga called from inside a saga', () => {
  const chargeCard = saga('charge', async (input: { amount: number }) => {
    const receipt = await step(
      'authorise',
      async () => ({ chargeId: `ch_${input.amount}` }),
      (charged) => {
        refunded.push(charged.chargeId)
      },
    )
    await step('capture', async () => ({ captured: true }))

    return receipt
  })
  const refunded: string[] = []

  it('flattens its steps into the caller under its own name', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const book = saga('booking.with-charge', async () => {
      await step('reserve', async () => ({ id: 'seat_1' }))
      await chargeCard({ amount: 42 })

      return 'done'
    })

    await book(undefined, flow)

    expect(journal.runs).toHaveLength(1)
    expect(journal.steps.map((row) => row.name)).toEqual([
      'reserve',
      'charge/authorise',
      'charge/capture',
    ])
  })

  it('undoes the child when the parent fails afterwards', async () => {
    refunded.length = 0
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const book = saga('booking.with-charge-failing', async () => {
      await chargeCard({ amount: 7 })
      await step('boom', async () => {
        throw new Error('no seats')
      })
    })

    const result = await book.try(undefined, flow)

    expect(result).toMatchObject({ ok: false, compensated: ['charge/authorise'] })
    expect(refunded).toEqual(['ch_7'])
    expect(journal.runs).toHaveLength(1)
  })

  it('still runs on its own when nobody is calling it', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    await chargeCard({ amount: 9 }, flow)

    expect(journal.runs.map((run) => run.name)).toEqual(['charge'])
    expect(journal.steps.map((row) => row.name)).toEqual(['authorise', 'capture'])
  })
})

// Zero configuration has to work or nobody tries the library. It also has to be replaceable in
// one line, at the top of a process, without touching a single saga.
describe('the default instance', () => {
  it('is replaced by sagaflow.configure', async () => {
    const journal = createMemoryJournal()
    sagaflow.configure({ journal: journal.journal })

    const write = saga('thing.configured', async () => step('write', async () => 1))

    await write(undefined)

    expect(journal.runs.map((run) => run.name)).toEqual(['thing.configured'])
  })
})

describe('a scope', () => {
  it('lets a call inside it find the instance', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const write = saga('thing.scoped', async () => step('write', async () => ctx().tenantId))

    const answered = await flow.scope({ tenantId: 'acme' }, () => write(undefined))

    expect(answered).toBe('acme')
    expect(journal.runs[0]?.tenantId).toBe('acme')
  })

  it('does not leak between two of them at once', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const write = saga('thing.scoped-race', async () =>
      step('write', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))

        return ctx().tenantId
      }),
    )

    const [a, b] = await Promise.all([
      flow.scope({ tenantId: 'one' }, () => write(undefined)),
      flow.scope({ tenantId: 'two' }, () => write(undefined)),
    ])

    expect([a, b]).toEqual(['one', 'two'])
  })

  it('is beaten by an instance handed in explicitly', async () => {
    const scoped = createMemoryJournal()
    const explicit = createMemoryJournal()
    const flow = sagaflow({ journal: scoped.journal })
    const other = sagaflow({ journal: explicit.journal })
    const write = saga('thing.explicit', async () => step('write', async () => 1))

    await flow.scope({ tenantId: 'scoped' }, () =>
      write(undefined, other.for({ tenantId: 'given' })),
    )

    expect(scoped.runs).toEqual([])
    expect(explicit.runs[0]?.tenantId).toBe('given')
  })
})
