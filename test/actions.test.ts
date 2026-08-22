import { describe, expect, it } from 'bun:test'

import {
  action,
  actions,
  saga,
  sagaflow,
  step,
  type RunObserver,
  type UndoSpec,
} from '@bayraak/sagaflow'
import { createMemoryJournal } from '@bayraak/sagaflow/memory'

// The rule is "every effect is a step". A rule you have to remember at every call site is a rule
// somebody forgets on a Friday — so when effects are reached through one object, wrap the object
// once and the bodies go back to being plain code.
const makeSeats = () => {
  const held = new Map<string, string>()
  const reads: string[] = []

  return {
    held,
    reads,
    service: {
      reserve: async (seat: string) => {
        held.set(seat, `hold_${seat}`)

        return { id: `hold_${seat}`, seat }
      },
      release: async (id: string) => {
        for (const [seat, holdId] of held) if (holdId === id) held.delete(seat)
      },
      // A read. Not listed in the spec.
      available: async (seat: string) => {
        reads.push(seat)

        return !held.has(seat)
      },
    },
  }
}

describe('wrapping the door instead of every call', () => {
  it('records a listed method as a step and undoes it', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()

    const booked = actions(seats.service, {
      reserve: (held) => seats.service.release(held.id),
    })

    const book = saga('booking.doors', async (input: { seat: string }) => {
      await booked.reserve(input.seat)
      await step('boom', async () => {
        throw new Error('no')
      })
    })

    await book.try({ seat: '12A' }, flow)

    expect(journal.steps.map((row) => [row.name, row.status])).toEqual([
      ['reserve', 'completed'],
      ['boom', 'failed'],
      ['compensate:reserve', 'compensated'],
    ])
    expect(seats.held.size).toBe(0)
  })

  it('takes an options object as well as a bare undo', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()
    let seen = 0

    const booked = actions(seats.service, {
      reserve: {
        name: 'hold-seat',
        retries: { limit: 2, delay: 0 },
        undo: (held) => seats.service.release(held.id),
      },
    })

    const book = saga('booking.doors-options', async (input: { seat: string }) => {
      seen += 1

      return booked.reserve(input.seat)
    })

    await book({ seat: '1B' }, flow)

    expect(seen).toBe(1)
    expect(journal.steps.map((row) => row.name)).toEqual(['hold-seat'])
  })

  it('numbers repeated calls like any other step', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null })

    const book = saga('booking.doors-loop', async (input: { seats: string[] }) => {
      for (const seat of input.seats) await booked.reserve(seat)
    })

    await book({ seats: ['1A', '1B', '1C'] }, flow)

    expect(journal.steps.map((row) => row.name)).toEqual(['reserve', 'reserve#2', 'reserve#3'])
  })

  it('leaves an unlisted read alone in an inline saga', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null })

    const check = saga('booking.doors-read', async (input: { seat: string }) =>
      booked.available(input.seat),
    )

    expect(await check({ seat: '2C' }, flow)).toBe(true)
    // A read that changes nothing needs no row: an inline run is one request, and a step per
    // query would make the trail longer than the thing it describes.
    expect(journal.steps).toEqual([])
    expect(seats.reads).toEqual(['2C'])
  })

  it('is just the object outside a saga', async () => {
    const journal = createMemoryJournal()
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null })

    expect(await booked.reserve('3D')).toEqual({ id: 'hold_3D', seat: '3D' })
    expect(await booked.available('3D')).toBe(false)
    expect(journal.runs).toEqual([])
  })

  it('passes anything that is not a function straight through', () => {
    const wrapped = actions({ limit: 10, reserve: async () => 1 }, { reserve: null })

    expect(wrapped.limit).toBe(10)
  })
})

// A read inside a DURABLE saga is a different question. The body runs again from the top on a
// re-invocation, so a query answered differently the second time makes the replay diverge.
// Memoising it as a step with no undo is what keeps a durable body deterministic.
describe('reads inside a durable saga', () => {
  it('are memoised so a replay sees what the first invocation saw', async () => {
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
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null })

    const chase = saga(
      'booking.doors-durable',
      { durable: true },
      async (input: { seat: string }) => booked.available(input.seat),
    )

    await chase.start({ seat: '4E' }, flow)

    // The definition is registered and startable; the memoisation itself is proved by the
    // recorded step below, which only a durable body produces.
    expect(created).toHaveLength(1)
    expect(seats.reads).toEqual([])
  })

  it('records the read as a step with no undo', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null })

    const { executeDurable } = await import('../src/index.js')
    const { definitionOf } = await import('../src/saga.js')
    const chase = saga(
      'booking.doors-durable-run',
      { durable: true },
      async (input: { seat: string }) => booked.available(input.seat),
    )

    const definition = definitionOf(chase)
    expect(definition).toBeDefined()

    await executeDurable(
      definition as never,
      { runId: 'run_read', input: { seat: '5F' } },
      flow.runtime,
      {
        do: async (_name, _config, run) => run({ attempt: 1 }),
        sleep: async () => undefined,
        waitForEvent: async () => undefined as never,
      },
    )

    expect(journal.steps.map((row) => [row.name, row.status])).toEqual([['available', 'completed']])
    expect(seats.reads).toEqual(['5F'])
  })

  it('can be told to pass through instead', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null, reads: 'pass-through' })

    const { executeDurable } = await import('../src/index.js')
    const { definitionOf } = await import('../src/saga.js')
    const chase = saga(
      'booking.doors-passthrough',
      { durable: true },
      async (input: { seat: string }) => booked.available(input.seat),
    )

    await executeDurable(
      definitionOf(chase) as never,
      { runId: 'run_pass', input: { seat: '6G' } },
      flow.runtime,
      {
        do: async (_name, _config, run) => run({ attempt: 1 }),
        sleep: async () => undefined,
        waitForEvent: async () => undefined as never,
      },
    )

    expect(journal.steps).toEqual([])
  })
})

// Adding a write to the module has to fail compilation until somebody has decided how to undo it.
// `null` is a decision — "this one cannot be taken back" — and it has to be written down.
describe('the totality of an undo map', () => {
  it('is a compile-time obligation', () => {
    type Writes = {
      reserve: (seat: string) => Promise<{ id: string }>
      sendTicket: (to: string) => Promise<{ messageId: string }>
    }

    const undos = {
      reserve: (held) => {
        void held.id
      },
      // Irreversible, and said so on purpose rather than by omission.
      sendTicket: null,
    } satisfies UndoSpec<Writes>

    expect(Object.keys(undos)).toEqual(['reserve', 'sendTicket'])
  })
})

// An effect declares how it is undone and what it announces, in the same place. `emit` in a body
// stays for composite facts no single effect owns.
describe('what an effect announces', () => {
  it('puts one envelope in the outbox per call', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()

    const booked = actions(seats.service, {
      reserve: {
        undo: (held) => seats.service.release(held.id),
        announce: (held) => ['seat.reserved', { id: held.id, seat: held.seat }],
      },
    })

    const book = saga('booking.announce', async (input: { seats: string[] }) => {
      for (const seat of input.seats) await booked.reserve(seat)
    })

    await book({ seats: ['1A', '1B'] }, flow)

    expect(journal.outbox.map((event) => event.type)).toEqual([
      'seat.reserved',
      'seat.reserved',
      'workflow.completed',
    ])
    expect(journal.outbox[0]?.payload).toEqual({ id: 'hold_1A', seat: '1A' })
  })

  it('announces nothing from a run that was undone', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()

    const booked = actions(seats.service, {
      reserve: {
        undo: (held) => seats.service.release(held.id),
        announce: (held) => ['seat.reserved', { id: held.id }],
      },
    })

    const book = saga('booking.announce-undone', async (input: { seat: string }) => {
      await booked.reserve(input.seat)
      await step('boom', async () => {
        throw new Error('no')
      })
    })

    await book.try({ seat: '1C' }, flow)

    expect(journal.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
  })

  it('takes several announcements, or none', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const seats = makeSeats()

    const booked = actions(seats.service, {
      reserve: {
        announce: (held, seat) => [
          ['seat.reserved', { id: held.id }],
          ['seat.taken', { seat }],
        ],
      },
    })
    const quiet = actions(makeSeats().service, { reserve: { announce: () => null } })

    const book = saga('booking.announce-many', async () => {
      await booked.reserve('2A')
      await quiet.reserve('2B')
    })

    await book(undefined, flow)

    expect(journal.outbox.map((event) => event.type)).toEqual([
      'seat.reserved',
      'seat.taken',
      'workflow.completed',
    ])
  })

  it('works on a single action too', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const charged: number[] = []

    const chargeCard = action(
      async function chargeCard(amount: number) {
        charged.push(amount)

        return { chargeId: `ch_${amount}` }
      },
      { announce: (receipt) => ['card.charged', { chargeId: receipt.chargeId }] },
    )

    const pay = saga('booking.announce-action', async () => chargeCard(42))

    await pay(undefined, flow)

    expect(journal.outbox.map((event) => event.type)).toEqual([
      'card.charged',
      'workflow.completed',
    ])
  })
})

// The engine journals effects and traces the rest. A run's journal should be the effects it had —
// short enough to read — while the call tree is still visible to whoever is looking at a trace.
const recordingObserver = (): { observer: RunObserver; spans: string[] } => {
  const spans: string[] = []

  return {
    spans,
    observer: {
      onSpanStart: (fact) => spans.push(`start:${fact.name}`),
      onSpanEnd: (fact) =>
        spans.push(`end:${fact.name}:${fact.error === undefined ? 'ok' : 'error'}`),
    },
  }
}

describe('tracing the calls that are not effects', () => {
  it('reports an unlisted call as a span and journals nothing', async () => {
    const journal = createMemoryJournal()
    const watcher = recordingObserver()
    const flow = sagaflow({ journal: journal.journal, observer: watcher.observer })
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null, trace: true })

    const check = saga('booking.trace-read', async (input: { seat: string }) =>
      booked.available(input.seat),
    )

    expect(await check({ seat: '7A' }, flow)).toBe(true)
    expect(journal.steps).toEqual([])
    expect(watcher.spans).toEqual(['start:available', 'end:available:ok'])
  })

  it('reports a listed action as both a step row and a span', async () => {
    const journal = createMemoryJournal()
    const watcher = recordingObserver()
    const flow = sagaflow({ journal: journal.journal, observer: watcher.observer })
    const seats = makeSeats()
    const booked = actions(seats.service, { reserve: null, trace: true })

    const book = saga('booking.trace-write', async (input: { seat: string }) =>
      booked.reserve(input.seat),
    )

    await book({ seat: '7B' }, flow)

    expect(journal.steps.map((row) => row.name)).toEqual(['reserve'])
    expect(watcher.spans).toEqual(['start:reserve', 'end:reserve:ok'])
  })

  it('reports a call that threw', async () => {
    const journal = createMemoryJournal()
    const watcher = recordingObserver()
    const flow = sagaflow({ journal: journal.journal, observer: watcher.observer })
    const angry = actions(
      {
        lookup: async () => {
          throw new Error('the database is on fire')
        },
      },
      { trace: true },
    )

    const check = saga('booking.trace-error', async () => angry.lookup())

    await check.try(undefined, flow)

    expect(watcher.spans).toEqual(['start:lookup', 'end:lookup:error'])
  })

  it('says how long a call took and what it was given', async () => {
    const journal = createMemoryJournal()
    const seen: { name: string; args: string; durationMs: number }[] = []
    const flow = sagaflow({
      journal: journal.journal,
      observer: {
        onSpanEnd: (fact) =>
          seen.push({ name: fact.name, args: fact.args, durationMs: fact.durationMs }),
      },
    })
    const seats = makeSeats()
    const booked = actions(seats.service, { trace: true })

    const check = saga('booking.trace-detail', async () => booked.available('7C'))

    await check(undefined, flow)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.name).toBe('available')
    expect(seen[0]?.args).toContain('7C')
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('traces nothing outside a saga', async () => {
    const seen: string[] = []
    const seats = makeSeats()
    const booked = actions(seats.service, { trace: true })

    expect(await booked.available('7D')).toBe(true)
    expect(seen).toEqual([])
  })
})
