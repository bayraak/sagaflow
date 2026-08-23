import { action, emit, saga, sagaflow } from 'sagaflow-js'
import { createInProcessSink, createMemoryJournal } from 'sagaflow-js/memory'
import { z } from 'zod'

/*
 * A saga on a plain Bun server. No Cloudflare, no wrangler, no platform of any kind — this is
 * what "inline runs anywhere" means, and it is the shape most mutations should have.
 *
 * Swap `createMemoryJournal()` for `createSqliteJournal(new Database('sagas.db'))` and the state
 * outlives the process. Nothing else changes.
 */

const seats = new Map<string, string>()
const charges = new Set<string>()

const reserveSeat = action(
  async function reserveSeat(seat: string) {
    if (seats.has(seat)) throw new Error(`seat ${seat} is already taken`)

    const id = `hold_${seat}`
    seats.set(seat, id)

    return { id, seat, price: 4200 }
  },
  {
    undo: (held) => {
      seats.delete(held.seat)
    },
  },
)

const chargeCard = action(
  async function chargeCard(amount: number) {
    const id = `ch_${amount}_${charges.size}`
    charges.add(id)

    return { id, amount }
  },
  {
    undo: (receipt) => {
      charges.delete(receipt.id)
    },
  },
)

export const createBooking = saga(
  'booking.create',
  { input: z.object({ seat: z.string().min(1), confirm: z.boolean().default(true) }) },
  async (input) => {
    const held = await reserveSeat(input.seat)
    const receipt = await chargeCard(held.price)

    // A pure check needs no step. If it throws, the run undoes itself and says why.
    if (!input.confirm) throw new Error('the booking was not confirmed')

    await emit('booking.created', { seat: held.seat, chargeId: receipt.id })

    return { seat: held.seat, chargeId: receipt.id }
  },
)

/** The run record and the events both live here. In production, both live in your database. */
export const journal = createMemoryJournal()
export const delivered: string[] = []

export const flow = sagaflow({
  journal: journal.journal,
  events: createInProcessSink((envelope) => {
    delivered.push(envelope.type)
  }),
  sagas: [createBooking],
})

export const state = { seats, charges }
