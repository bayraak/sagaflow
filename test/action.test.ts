import { describe, expect, it } from 'bun:test'

import { action, attempt, idempotencyKey, saga, sagaflow, step } from '@bayraak/sagaflow'
import { createMemoryJournal } from '@bayraak/sagaflow/memory'

async function chargeCard(amount: number) {
  return { chargeId: `ch_${amount}` }
}

const settle = (ms: number): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms))

// An undo belongs with the effect it undoes, not at every call site. Written once, beside the
// thing it reverses, it is right everywhere — and the call sites read like the code they would
// have been anyway.
describe('an action', () => {
  it('records itself as a step when a saga calls it, and undoes itself', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const released: string[] = []

    const reserveSeat = action(async (seat: string) => ({ id: `seat_${seat}`, price: 4200 }), {
      name: 'reserve-seat',
      undo: (reserved) => {
        released.push(reserved.id)
      },
    })

    const book = saga('booking.action', async (input: { seat: string }) => {
      const seat = await reserveSeat(input.seat)
      await step('boom', async () => {
        throw new Error('no')
      })

      return seat
    })

    const result = await book.try({ seat: '12A' }, flow)

    expect(result.ok).toBe(false)
    expect(released).toEqual(['seat_12A'])
    expect(journal.steps.map((row) => [row.name, row.status])).toEqual([
      ['reserve-seat', 'completed'],
      ['boom', 'failed'],
      ['compensate:reserve-seat', 'compensated'],
    ])
  })

  it('takes its name from the function when it has one', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const charge = action(chargeCard)
    const pay = saga('booking.named-action', async () => charge(42))

    await pay(undefined, flow)

    expect(journal.steps.map((row) => row.name)).toEqual(['chargeCard'])
  })

  it('refuses an anonymous function with no name given', () => {
    expect(() => action(async (value: number) => value)).toThrow('name')
  })

  it('reads the step context ambiently', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })
    const seen: string[] = []

    const authorise = action(
      async (amount: number) => {
        seen.push(idempotencyKey(), String(attempt()))

        return amount
      },
      { name: 'authorise' },
    )

    const pay = saga('booking.action-ctx', async () => authorise(1))

    await pay(undefined, flow)

    expect(seen).toEqual(['run_1:0', '1'])
  })

  // The same function, outside a saga, is just the function. That is what makes an action safe to
  // put on a service: the service keeps working for every caller that is not a saga.
  it('is just the function outside a saga', async () => {
    const journal = createMemoryJournal()
    const reserveSeat = action(async (seat: string) => ({ id: `seat_${seat}` }), {
      name: 'reserve-seat',
      undo: () => {
        throw new Error('should never run')
      },
    })

    expect(await reserveSeat('1A')).toEqual({ id: 'seat_1A' })
    expect(journal.runs).toEqual([])
  })

  it('carries its own budget', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })
    let seen = 0

    const flaky = action(
      async () => {
        seen += 1
        if (seen < 3) throw new Error('not yet')

        return seen
      },
      { name: 'flaky', retries: { limit: 3, delay: 0 } },
    )

    const run = saga('booking.action-retry', async () => flaky())

    expect(await run(undefined, flow)).toBe(3)
    expect(seen).toBe(3)
  })
})

// A name used more than once in a run is numbered rather than refused. The platform needs the
// names to be unique and deterministic; a caller writing a loop should not have to invent them.
describe('the same step name more than once', () => {
  it('numbers them in call order', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const reserve = action(async (seat: string) => ({ id: seat }), { name: 'reserve' })

    const book = saga('booking.loop', async (input: { seats: string[] }) => {
      const held = []
      for (const seat of input.seats) held.push(await reserve(seat))

      return held
    })

    const held = await book({ seats: ['1A', '1B', '1C'] }, flow)

    expect(held).toEqual([{ id: '1A' }, { id: '1B' }, { id: '1C' }])
    expect(journal.steps.map((row) => row.name)).toEqual(['reserve', 'reserve#2', 'reserve#3'])
  })

  it('numbers inline steps the same way', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const twice = saga('booking.twice', async () => {
      await step('write', async () => 1)
      await step('write', async () => 2)
    })

    await twice(undefined, flow)

    expect(journal.steps.map((row) => row.name)).toEqual(['write', 'write#2'])
  })

  it('numbers them by start order under Promise.all', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const write = action(
      async (delay: number) => {
        await settle(delay)

        return delay
      },
      { name: 'write' },
    )

    const fan = saga('booking.fan-numbered', async () => Promise.all([write(10), write(0)]))

    await fan(undefined, flow)

    // The slow one was asked for first, so it is `write`, however it finished.
    expect(journal.steps.map((row) => [row.name, row.output]).toSorted()).toEqual(
      [
        ['write', 10],
        ['write#2', 0],
      ].toSorted(),
    )
  })

  it('undoes numbered steps in reverse start order', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })
    const undone: string[] = []

    const reserve = action(async (seat: string) => seat, {
      name: 'reserve',
      undo: (seat) => {
        undone.push(seat)
      },
    })

    const book = saga('booking.loop-undo', async () => {
      await reserve('1A')
      await reserve('1B')
      await step('boom', async () => {
        throw new Error('no')
      })
    })

    await book.try(undefined, flow)

    expect(undone).toEqual(['1B', '1A'])
  })
})
