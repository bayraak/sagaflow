import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  SELF,
} from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { instanceIdFor } from '../src/index.js'
import type { TestEnv } from './definitions.js'
import { applySchema, truncate } from './schema.js'
import worker from './worker.js'

const bindings = env as unknown as TestEnv

const first = async <Row>(sql: string, ...params: unknown[]): Promise<Row | null> =>
  bindings.DB.prepare(sql)
    .bind(...params)
    .first<Row>()

const all = async <Row>(sql: string, ...params: unknown[]): Promise<Row[]> => {
  const answered = await bindings.DB.prepare(sql)
    .bind(...params)
    .all<Row>()

  return answered.results
}

// A whole mutation, through a real worker, on real D1, with a real queue at the end of it.
// Everything the bun suite proves against arrays is proved here against the platform.
describe('an inline run inside a worker', () => {
  beforeAll(async () => {
    await applySchema(bindings.DB)
  })

  beforeEach(async () => {
    await truncate(bindings.DB)
  })

  it('writes its row, its run, its steps and its events', async () => {
    const response = await SELF.fetch('https://sagaflow.test/inline?mark=THING-1')
    const body = (await response.json()) as { runId: string; deduplicated: boolean }

    expect(body.deduplicated).toBe(false)

    const run = await first<{ status: string; execution: string; tenant_id: string }>(
      'select status, execution, tenant_id from saga_runs where id = ?',
      body.runId,
    )
    expect(run).toMatchObject({ status: 'completed', execution: 'inline', tenant_id: 'tenant_a' })

    const steps = await all<{ name: string; status: string }>(
      'select name, status from saga_run_steps where run_id = ? order by seq',
      body.runId,
    )
    expect(steps).toEqual([{ name: 'write-thing', status: 'completed' }])

    const thing = await first<{ mark: string }>(
      'select mark from things where id = ?',
      `${body.runId}:0`,
    )
    expect(thing?.mark).toBe('THING-1')

    const events = await all<{ id: string; type: string; dispatched_at: number | null }>(
      'select id, type, dispatched_at from saga_outbox where run_id = ? order by id',
      body.runId,
    )
    expect(events.map((event) => event.type)).toEqual(['thing.saved', 'workflow.completed'])
    expect(events.map((event) => event.id)).toEqual([`${body.runId}:0`, `${body.runId}:1`])
    expect(events.every((event) => event.dispatched_at !== null)).toBe(true)
  })

  /*
   * The producer half is real: the drain hands its batch to a real Queues binding, and
   * `dispatched_at` is only stamped once that call came back. The broker itself is not emulated
   * in this runtime — the pool hands you `createMessageBatch` and the handler instead — so the
   * consumer half is exercised as the platform would exercise it, with a real MessageBatch of
   * the messages this run actually produced.
   */
  it('delivers what it drained to a consumer that can read it', async () => {
    const response = await SELF.fetch('https://sagaflow.test/inline?mark=THING-2')
    const body = (await response.json()) as { runId: string }

    const drained = await all<{ payload: string }>(
      'select payload from saga_outbox where run_id = ? order by id',
      body.runId,
    )

    const batch = createMessageBatch<{ id: string; type: string }>(
      'sagaflow-test-events',
      drained.map((row, index) => ({
        id: `message-${index}`,
        timestamp: new Date(),
        attempts: 1,
        body: JSON.parse(row.payload) as { id: string; type: string },
      })),
    )
    const context = createExecutionContext()
    await worker.queue(batch, bindings)
    const result = await getQueueResult(batch, context)

    expect(result.explicitAcks).toHaveLength(2)

    const delivered = await all<{ id: string; type: string }>(
      'select id, type from delivered order by id',
    )
    expect(delivered.map((row) => row.type)).toEqual(['thing.saved', 'workflow.completed'])
    expect(delivered.map((row) => row.id)).toEqual([`${body.runId}:0`, `${body.runId}:1`])
  })

  // An instance still sleeping when the runtime is torn down is a request that never answers,
  // and the pool says so loudly. Waiting is not politeness.
  const settle = async (runId: string): Promise<void> => {
    const instance = await bindings.WORKFLOWS.get(instanceIdFor('thing.ship', runId))

    await vi.waitFor(
      async () => {
        expect(['complete', 'errored', 'terminated']).toContain((await instance.status()).status)
      },
      { timeout: 20_000, interval: 100 },
    )
  }

  it('holds an idempotency key per tenant', async () => {
    const one = await SELF.fetch('https://sagaflow.test/durable?mark=SHARED&tenant=tenant_a')
    const two = await SELF.fetch('https://sagaflow.test/durable?mark=SHARED&tenant=tenant_b')

    const original = (await one.json()) as { runId: string; deduplicated: boolean }
    const second = (await two.json()) as { runId: string; deduplicated: boolean }

    expect(original.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(false)
    expect(second.runId).not.toBe(original.runId)

    await settle(original.runId)
    await settle(second.runId)
  }, 30_000)
})
