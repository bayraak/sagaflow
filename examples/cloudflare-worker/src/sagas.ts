import { action, emit, saga, sagaflow, sleep, step } from '@bayraak/sagaflow'
import { createD1Journal } from '@bayraak/sagaflow/d1'
import { env } from 'cloudflare:workers'
import { z } from 'zod'

export type Env = {
  DB: D1Database
  WORKFLOWS: Workflow
  EVENTS: Queue<unknown>
}

const bindings = env as unknown as Env

const reserveSeat = action(
  async function reserveSeat(input: { seat: string; tenantId: string }) {
    const id = `hold_${input.seat}`
    await bindings.DB.prepare('insert into seats (id, tenant_id, seat) values (?, ?, ?)')
      .bind(id, input.tenantId, input.seat)
      .run()

    return { id }
  },
  {
    undo: async (held) => {
      await bindings.DB.prepare('delete from seats where id = ?').bind(held.id).run()
    },
  },
)

/** Inline: a short mutation against our own database, answered in the same request. */
export const createBooking = saga(
  'booking.create',
  { input: z.object({ seat: z.string().min(1) }), idempotent: true },
  async (input) => {
    const held = await reserveSeat({ seat: input.seat, tenantId: 'acme' })
    await emit('booking.created', { seat: input.seat })

    return { id: held.id }
  },
)

/** Durable: it sleeps, so it must survive a deploy. */
export const chaseBooking = saga(
  'booking.chase',
  { input: z.object({ seat: z.string().min(1) }), durable: true, idempotent: true },
  async (input) => {
    await sleep('grace-period', '1 second')
    await step('remind', async () => ({ reminded: input.seat }))
    await emit('booking.chased', { seat: input.seat })

    return { chased: input.seat }
  },
)

export const flow = sagaflow({
  journal: createD1Journal(bindings.DB),
  events: bindings.EVENTS,
  launcher: bindings.WORKFLOWS,
  sagas: [createBooking, chaseBooking],
})
