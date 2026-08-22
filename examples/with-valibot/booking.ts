import { action, saga, sagaflow } from 'sagaflow'
import { createMemoryJournal } from 'sagaflow/memory'
import * as v from 'valibot'

/*
 * The same saga, validated by Valibot instead of Zod.
 *
 * sagaflow never imports either. Validation is Standard Schema, so a schema is anything carrying
 * a `~standard` property — bring the validator you already have, and if you change your mind
 * later, change the schema and nothing else.
 */

export const bookingInput = v.object({
  seat: v.pipe(v.string(), v.minLength(1)),
  passenger: v.pipe(v.string(), v.email()),
})

export const bookingOutput = v.object({ seat: v.string(), reference: v.string() })

const reserveSeat = action(
  async function reserveSeat(seat: string) {
    return { id: `hold_${seat}`, seat }
  },
  {
    undo: (held) => {
      released.push(held.id)
    },
  },
)

export const released: string[] = []

export const createBooking = saga(
  'booking.create',
  { input: bookingInput, output: bookingOutput },
  async (input) => {
    const held = await reserveSeat(input.seat)

    return { seat: held.seat, reference: `${held.id}/${input.passenger}` }
  },
)

export const journal = createMemoryJournal()
export const flow = sagaflow({ journal: journal.journal, sagas: [createBooking] })
