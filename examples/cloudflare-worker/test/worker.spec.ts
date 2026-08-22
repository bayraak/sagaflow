import { env, SELF } from 'cloudflare:test'
import { instanceIdFor } from 'sagaflow'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import ddl from '../migrations/0001_sagaflow.sql?raw'
import type { Env } from '../src/sagas.js'

const bindings = env as unknown as Env

const statements = ddl
  .replaceAll(/^\s*--.*$/gm, '')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)

const all = async <Row>(sql: string, ...params: unknown[]): Promise<Row[]> =>
  (
    await bindings.DB.prepare(sql)
      .bind(...params)
      .all<Row>()
  ).results

describe('the cloudflare-worker example', () => {
  beforeAll(async () => {
    for (const statement of statements) await bindings.DB.prepare(statement).run()
  })

  beforeEach(async () => {
    for (const table of ['saga_outbox', 'saga_run_steps', 'saga_runs', 'seats']) {
      await bindings.DB.prepare(`delete from ${table}`).run()
    }
  })

  it('books a seat inline and leaves the whole record behind', async () => {
    const response = await SELF.fetch('https://example.test/bookings?seat=12A')

    expect(response.status).toBe(201)

    const runs = await all<{ name: string; status: string }>('select name, status from saga_runs')
    expect(runs).toEqual([{ name: 'booking.create', status: 'completed' }])

    const seats = await all<{ seat: string }>('select seat from seats')
    expect(seats).toEqual([{ seat: '12A' }])

    const events = await all<{ type: string }>('select type from saga_outbox order by id')
    expect(events.map((event) => event.type)).toEqual(['booking.created', 'workflow.completed'])
  })

  it('answers the same booking twice with one run', async () => {
    await SELF.fetch('https://example.test/bookings?seat=1B')
    await SELF.fetch('https://example.test/bookings?seat=1B')

    expect(await all('select id from saga_runs')).toHaveLength(1)
  })

  it('runs a durable saga to completion on a real Workflows binding', async () => {
    const response = await SELF.fetch('https://example.test/chase?seat=2C')
    const { runId } = (await response.json()) as { runId: string }

    const instance = await bindings.WORKFLOWS.get(instanceIdFor('booking.chase', runId))
    await vi.waitFor(
      async () => {
        expect((await instance.status()).status).toBe('complete')
      },
      { timeout: 20_000, interval: 100 },
    )

    const run = await all<{ status: string; execution: string }>(
      'select status, execution from saga_runs where id = ?',
      runId,
    )
    expect(run).toEqual([{ status: 'completed', execution: 'durable' }])

    const steps = await all<{ name: string }>(
      'select name from saga_run_steps where run_id = ? order by seq',
      runId,
    )
    expect(steps.map((row) => row.name)).toEqual(['remind'])
  })
})
