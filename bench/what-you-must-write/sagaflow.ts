import { emit, saga, sagaflow, step } from '@bayraak/sagaflow'
import { createD1Journal } from '@bayraak/sagaflow/d1'

type Env = { DB: D1Database; EVENTS: Queue<unknown> }

declare const env: Env

const flow = sagaflow({
  journal: createD1Journal(env.DB),
  events: env.EVENTS,
})

export const bookSeat = saga(
  'booking.create',
  { idempotent: true },
  async (input: { seat: string; card: string; email: string }) => {
    const held = await step(
      'hold-seat',
      () => holdSeat(input.seat),
      (hold) => releaseSeat(hold.id),
    )

    const charge = await step(
      'charge-card',
      () => chargeCard(input.card, held.price),
      (paid) => refund(paid.id),
    )

    await step('send-confirmation', () => sendConfirmation(input.email, held.id))
    await emit('booking.created', { holdId: held.id, chargeId: charge.id })

    return { holdId: held.id }
  },
)

export const book = (input: { seat: string; card: string; email: string }, tenantId: string) =>
  bookSeat(input, flow.for({ tenantId }))

declare function holdSeat(seat: string): Promise<{ id: string; price: number }>
declare function releaseSeat(id: string): Promise<void>
declare function chargeCard(card: string, amount: number): Promise<{ id: string }>
declare function refund(id: string): Promise<void>
declare function sendConfirmation(email: string, holdId: string): Promise<void>
