import { env, SELF } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { instanceIdFor } from '../src/index.js'
import type { TestEnv } from './definitions.js'
import { applySchema, truncate } from './schema.js'

const bindings = env as unknown as TestEnv

const all = async <Row>(sql: string, ...params: unknown[]): Promise<Row[]> => {
  const answered = await bindings.DB.prepare(sql)
    .bind(...params)
    .all<Row>()

  return answered.results
}

const first = async <Row>(sql: string, ...params: unknown[]): Promise<Row | null> =>
  bindings.DB.prepare(sql)
    .bind(...params)
    .first<Row>()

const call = async (path: string): Promise<{ runId: string; deduplicated: boolean }> => {
  const response = await SELF.fetch(`https://sagaflow.test${path}`)

  return (await response.json()) as { runId: string; deduplicated: boolean }
}

/**
 * Wait for an instance to reach a terminal state. Not politeness: an instance still sleeping
 * when the runtime is torn down is a request that never answers, and the pool says so loudly.
 */
const settle = async (runId: string): Promise<void> => {
  const instance = await bindings.WORKFLOWS.get(instanceIdFor('thing.ship', runId))

  await vi.waitFor(
    async () => {
      const status = await instance.status()

      expect(['complete', 'errored', 'terminated']).toContain(status.status)
    },
    { timeout: 20_000, interval: 100 },
  )
}

// A durable run, end to end, on the real thing: a real Workflows instance, driven through the
// real step primitive, writing to real D1 — including a sleep, which is the capability that
// exists only in durable mode and only because a platform is carrying it.
describe('a durable run on a real Workflows binding', () => {
  beforeAll(async () => {
    await applySchema(bindings.DB)
  })

  beforeEach(async () => {
    await truncate(bindings.DB)
  })

  it('runs to completion and leaves the whole record behind', async () => {
    const started = await call('/durable?mark=SHIP-1')

    expect(started.deduplicated).toBe(false)

    await settle(started.runId)

    const instance = await bindings.WORKFLOWS.get(instanceIdFor('thing.ship', started.runId))
    expect((await instance.status()).status).toBe('complete')

    const run = await first<{ status: string; execution: string }>(
      'select status, execution from saga_runs where id = ?',
      started.runId,
    )
    expect(run).toMatchObject({ status: 'completed', execution: 'durable' })

    const steps = await all<{ name: string; status: string }>(
      'select name, status from saga_run_steps where run_id = ? order by seq',
      started.runId,
    )
    expect(steps).toEqual([{ name: 'write-thing', status: 'completed' }])

    const thing = await first<{ mark: string }>(
      'select mark from things where id = ?',
      `${started.runId}:0`,
    )
    expect(thing?.mark).toBe('SHIP-1')

    const events = await all<{ id: string; type: string; dispatched_at: number | null }>(
      'select id, type, dispatched_at from saga_outbox where run_id = ? order by id',
      started.runId,
    )
    expect(events.map((event) => event.type)).toEqual(['thing.shipped', 'workflow.completed'])
    expect(events.map((event) => event.id)).toEqual([
      `${started.runId}:0`,
      `${started.runId}:completed`,
    ])
    expect(events.every((event) => event.dispatched_at !== null)).toBe(true)
  }, 30_000)

  it('answers a second request for the same work with the run already doing it', async () => {
    const started = await call('/durable?mark=SHIP-2')
    const again = await call('/durable?mark=SHIP-2')

    expect(again).toEqual({ runId: started.runId, deduplicated: true })

    const runs = await all<{ id: string }>(
      'select id from saga_runs where name = ? and tenant_id = ?',
      'thing.ship',
      'tenant_a',
    )
    expect(runs).toHaveLength(1)

    await settle(started.runId)
  }, 30_000)
})

// The undo, over a real database, with the row actually gone at the end of it.
describe('a compensated run on real D1', () => {
  beforeAll(async () => {
    await applySchema(bindings.DB)
  })

  beforeEach(async () => {
    await truncate(bindings.DB)
  })

  it('removes what the completed step wrote and says so', async () => {
    const response = await SELF.fetch('https://sagaflow.test/inline-bad?mark=DOOMED')
    const body = (await response.json()) as {
      ok: boolean
      error?: { runId: string; outcome: string; failedStep: string }
    }

    expect(body.ok).toBe(false)
    expect(body.error?.outcome).toBe('compensated')
    expect(body.error?.failedStep).toBe('refuse')

    const run = await first<{ status: string; error: string }>(
      'select status, error from saga_runs where id = ?',
      body.error?.runId,
    )
    expect(run?.status).toBe('compensated')
    expect(run?.error).toContain('this step always refuses')

    const steps = await all<{ name: string; status: string }>(
      'select name, status from saga_run_steps where run_id = ? order by seq',
      body.error?.runId,
    )
    expect(steps).toEqual([
      { name: 'write-thing', status: 'completed' },
      { name: 'refuse', status: 'failed' },
      { name: 'compensate:write-thing', status: 'compensated' },
    ])

    const things = await all<{ id: string }>('select id from things')
    expect(things).toEqual([])

    const events = await all<{ type: string }>(
      'select type from saga_outbox where run_id = ?',
      body.error?.runId,
    )
    expect(events.map((event) => event.type)).toEqual(['workflow.compensated'])
  })

  // A key a compensated run used to hold for ever. It is free now, and the platform agrees.
  it('lets the same work be asked for again', async () => {
    const original = await call('/durable?mark=RETRYABLE')
    await bindings.DB.prepare("update saga_runs set status = 'compensated' where id = ?")
      .bind(original.runId)
      .run()

    const second = await call('/durable?mark=RETRYABLE')

    expect(second.deduplicated).toBe(false)
    expect(second.runId).not.toBe(original.runId)

    await settle(original.runId)
    await settle(second.runId)
  }, 30_000)
})
