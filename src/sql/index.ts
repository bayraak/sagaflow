import type { EventEnvelope, RunJournal, RunOutcome, RunStatus, WorkflowExecution } from '../types'
import type { SqlDriver } from './driver'

export type { SqlDriver, SqlStatement } from './driver'

/**
 * What the three tables are called. sagaflow does not own your schema — your migration tool
 * does — so if the names in `schema.sql` do not suit you, change them there and say so here.
 */
export type SqlTableNames = { runs: string; steps: string; outbox: string }

export const defaultTableNames: SqlTableNames = {
  runs: 'saga_runs',
  steps: 'saga_run_steps',
  outbox: 'saga_outbox',
}

type RunRow = { id: string; status: string; output: string | null }
type CancelRow = { cancel_requested: number }
type OutboxRow = { tenant_id: string; payload: string }

const heldStatuses = "('running', 'completed')"

const asStatus = (value: string): RunStatus => value as RunStatus

const identity = () => crypto.randomUUID()

const encode = (value: unknown) => (value === undefined ? null : JSON.stringify(value))

/**
 * The journal, in SQL, over whatever already talks to your database.
 *
 * Every rule of the contract is enforced by the store rather than by this file: the partial
 * unique index refuses a held key and releases it the moment a run ends, the conflict clauses
 * make a repeated write land on the row that exists, and the batch makes a finish one write.
 * That matters because those are the rules the engine relies on absolutely, and a rule enforced
 * in application code is a rule that a second writer can walk straight past.
 */
export const createSqlJournal = (
  driver: SqlDriver,
  options: { tables?: Partial<SqlTableNames>; now?: () => number } = {},
): RunJournal => {
  const tables = { ...defaultTableNames, ...options.tables }
  const now = options.now ?? (() => Date.now())

  return {
    insertRun: async (params) => {
      const id = identity()

      // No conflict clause on purpose: the index refusing this insert IS how the engine learns
      // that the key is held, and swallowing it would turn a duplicate into a silent no-op.
      await driver.run({
        sql: `insert into ${tables.runs}
                (id, tenant_id, name, execution, status, idempotency_key, replay_of,
                 parent_run_id, input, cancel_requested, started_at)
              values (?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, ?)`,
        params: [
          id,
          params.tenantId,
          params.name,
          params.execution,
          params.idempotencyKey,
          params.replayOf ?? null,
          params.parentRunId ?? null,
          JSON.stringify(params.input),
          now(),
        ],
      })

      return id
    },

    // One round trip for both questions: write the step, and answer whether anybody has asked
    // the run to stop. Cancellation is free because the engine was already talking to the
    // journal here.
    recordStep: async (params) => {
      const answers = await driver.batch([
        {
          sql: `insert into ${tables.steps}
                  (id, tenant_id, run_id, seq, name, status, attempt, output, error, recorded_at)
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict (run_id, seq, attempt) do nothing`,
          params: [
            identity(),
            params.tenantId,
            params.runId,
            params.seq,
            params.name,
            params.status,
            params.attempt,
            encode(params.output),
            params.error ?? null,
            now(),
          ],
        },
        {
          sql: `select cancel_requested from ${tables.runs} where tenant_id = ? and id = ?`,
          params: [params.tenantId, params.runId],
        },
      ])

      const asked = (answers[1] as CancelRow[] | undefined)?.[0]

      return { cancellationRequested: Number(asked?.cancel_requested ?? 0) === 1 }
    },

    // ONE write. The run closing and its events being queued are the same fact, and a store
    // that could be interrupted between them would make "completed, audit trail lost" a state
    // this library can produce.
    finishRun: async (params) => {
      const finishedAt = now()

      await driver.batch([
        {
          sql: `update ${tables.runs}
                set status = ?, output = ?, error = ?, finished_at = ?
                where tenant_id = ? and id = ?`,
          params: [
            params.status satisfies RunOutcome,
            encode(params.output),
            params.error ?? null,
            finishedAt,
            params.tenantId,
            params.runId,
          ],
        },
        ...(params.events ?? []).map((event) => ({
          sql: `insert into ${tables.outbox}
                  (id, tenant_id, run_id, type, payload, created_at, dispatched_at)
                values (?, ?, ?, ?, ?, ?, null)
                on conflict (id) do nothing`,
          params: [
            event.id,
            params.tenantId,
            event.runId,
            event.type,
            JSON.stringify(event),
            event.occurredAt,
          ],
        })),
      ])
    },

    markEventsDispatched: async (params) => {
      if (params.ids.length === 0) return

      await driver.run({
        sql: `update ${tables.outbox}
              set dispatched_at = ?
              where tenant_id = ? and id in (${params.ids.map(() => '?').join(', ')})`,
        params: [now(), params.tenantId, ...params.ids],
      })
    },

    findRunByIdempotencyKey: async (params) => {
      const rows = await driver.all<RunRow>({
        sql: `select id, status, output from ${tables.runs}
              where tenant_id = ? and idempotency_key = ? and status in ${heldStatuses}
              limit 1`,
        params: [params.tenantId, params.idempotencyKey],
      })

      const run = rows[0]
      if (!run) return null

      return {
        id: run.id,
        status: asStatus(run.status),
        output: run.output === null ? null : JSON.parse(run.output),
      }
    },

    requestCancellation: async (params) => {
      const answered = await driver.run({
        sql: `update ${tables.runs}
              set cancel_requested = 1
              where tenant_id = ? and id = ? and status = 'running'`,
        params: [params.tenantId, params.runId],
      })

      return answered.changes > 0
    },

    listUndispatchedEvents: async (params) => {
      const rows = await driver.all<OutboxRow>({
        sql: `select tenant_id, payload from ${tables.outbox}
              where dispatched_at is null and created_at <= ?
              order by created_at, id
              limit ?`,
        params: [params.before, params.limit],
      })

      return rows.map((row) => ({
        tenantId: row.tenant_id,
        envelope: JSON.parse(row.payload) as EventEnvelope,
      }))
    },

    failAbandonedRuns: async (params) => {
      const answered = await driver.run({
        sql: `update ${tables.runs}
              set status = 'failed', error = ?, finished_at = ?
              where execution = ? and status = 'running' and started_at < ?`,
        params: [
          params.error,
          now(),
          params.execution satisfies WorkflowExecution,
          params.startedBefore,
        ],
      })

      return answered.changes
    },
  }
}
