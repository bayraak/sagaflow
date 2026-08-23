import { env } from 'cloudflare:workers'
import { z } from 'zod'

import { createD1Journal } from '../src/d1/index.js'
import { ctx, emit, saga, sagaflow, sleep, step } from '../src/index.js'
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
    async (inStep) => {
      await bindings.DB.prepare('insert into things (id, tenant_id, mark) values (?, ?, ?)')
        .bind(inStep.idempotencyKey, inStep.tenantId, mark)
        .run()

      return { id: inStep.idempotencyKey }
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

    // Inside an instance there is no request — only this.env — so whatever a host builds from
    // env has to reach the body through the scope the entrypoint was given. Recorded here
    // because a scope that quietly arrives empty is the failure that costs an afternoon.
    const scope = ctx<{ builtFrom?: string }>()
    await bindings.DB.prepare('insert into scopes (run_id, built_from, tenant_id) values (?, ?, ?)')
      .bind(written.id, scope.builtFrom ?? 'nothing', scope.tenantId)
      .run()

    await sleep('settle', '1 second')
    await emit('thing.shipped', { id: written.id })

    return { id: written.id }
  },
)

/**
 * What a host builds per instance, from that instance's own env.
 *
 * A worker's bindings are not available where a class is declared — they arrive with the
 * invocation — so the entrypoint takes a factory and calls it with `this.env`.
 */
export const flowFrom = (workerEnv: TestEnv) =>
  sagaflow({
    journal: createD1Journal(workerEnv.DB),
    events: workerEnv.EVENTS,
    launcher: workerEnv.WORKFLOWS,
    sagas: [saveThing, saveThingBadly, shipThing],
  }).for({ builtFrom: 'env' })

/** Configured once, at module scope, from the worker's own bindings. */
export const flow = sagaflow({
  journal: createD1Journal(bindings.DB),
  events: bindings.EVENTS,
  launcher: bindings.WORKFLOWS,
  sagas: [saveThing, saveThingBadly, shipThing],
})
