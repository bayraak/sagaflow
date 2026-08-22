import { env } from 'cloudflare:workers'
import { z } from 'zod'

import { createD1Journal } from '../src/d1/index.js'
import { emit, saga, sagaflow, sleep, step } from '../src/index.js'
import type { EventSink } from '../src/index.js'

export type TestEnv = {
  DB: D1Database
  WORKFLOWS: Workflow
  EVENTS: Queue<unknown> & EventSink
}

export const bindings = env as unknown as TestEnv

const thingInput = z.object({ mark: z.string().min(1) })

// A step with a real database effect and a real undo, written the way a caller writes one: a
// plain function that calls the verb.
const writeThing = (mark: string) =>
  step(
    'write-thing',
    async (ctx) => {
      await bindings.DB.prepare('insert into things (id, tenant_id, mark) values (?, ?, ?)')
        .bind(ctx.idempotencyKey, ctx.tenantId, mark)
        .run()

      return { id: ctx.idempotencyKey }
    },
    async (written) => {
      await bindings.DB.prepare('delete from things where id = ?').bind(written.id).run()
    },
  )

export const saveThing = saga('thing.save', { input: thingInput }, async (input) => {
  const written = await writeThing(input.mark)
  await emit('thing.saved', { id: written.id })

  return { id: written.id }
})

export const saveThingBadly = saga('thing.save-badly', { input: thingInput }, async (input) => {
  await writeThing(input.mark)
  await step('refuse', async (): Promise<never> => {
    throw new Error('this step always refuses')
  })
})

export const shipThing = saga(
  'thing.ship',
  { input: thingInput, durable: true, idempotent: (input) => `thing.ship:${input.mark}` },
  async (input) => {
    const written = await writeThing(input.mark)
    await sleep('settle', '1 second')
    await emit('thing.shipped', { id: written.id })

    return { id: written.id }
  },
)

/** Configured once, at module scope, from the worker's own bindings. */
export const flow = sagaflow({
  journal: createD1Journal(bindings.DB),
  events: bindings.EVENTS,
  launcher: bindings.WORKFLOWS,
  sagas: [saveThing, saveThingBadly, shipThing],
})
