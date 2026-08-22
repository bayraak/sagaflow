import { IdempotencyKeyHeldError } from '../errors.js'
import type {
  EventEnvelope,
  EventSink,
  RunJournal,
  RunOutcome,
  RunStatus,
  WorkflowExecution,
} from '../types.js'

export type MemoryRunRow = {
  id: string
  tenantId: string
  name: string
  execution: WorkflowExecution
  idempotencyKey: string | null
  parentRunId: string | null
  input: unknown
  status: RunStatus
  cancelRequested: boolean
  startedAt: number
  output?: unknown
  error?: string | null
}

export type MemoryStepRow = {
  tenantId: string
  runId: string
  seq: number
  name: string
  status: string
  attempt: number
  output?: unknown
  error?: string | null
}

export type MemoryFinishRow = {
  runId: string
  status: RunOutcome
  output?: unknown
  error?: string | null
  events: EventEnvelope[]
}

/**
 * The journal, plus the rows it is holding, so a test asserts on what was written rather than
 * on which function was called.
 */
export type MemoryJournal = {
  journal: RunJournal
  runs: MemoryRunRow[]
  steps: MemoryStepRow[]
  finishes: MemoryFinishRow[]
  outbox: EventEnvelope[]
  dispatched: string[]
  /**
   * Make every outbox write fail from here on, so a suite can prove that a finish which cannot
   * queue its events does not close the run either.
   */
  breakOutboxWrites: () => void
}

/**
 * The journal a test reaches for, and the worked reference for writing your own: rows in
 * arrays, and the one invariant a real table has to enforce — a single claim per
 * (tenant, idempotency key) — enforced here too, so a suite exercises the engine's behaviour
 * rather than a fixture's convenience.
 */
export const createMemoryJournal = (options: { now?: () => number } = {}): MemoryJournal => {
  const now = options.now ?? ((): number => Date.now())
  let outboxWritesFail = false
  const runs: MemoryRunRow[] = []
  const steps: MemoryStepRow[] = []
  const finishes: MemoryFinishRow[] = []
  const outbox: EventEnvelope[] = []
  const dispatched: string[] = []

  // A key is claimed by a run that is still standing — running, or completed and answerable.
  // A run that failed, compensated or was cancelled RELEASES its key, because the work it was
  // asked to do did not happen and asking again is the only way to get it done. A table
  // enforces the same rule with a partial unique index; see src/d1/schema.sql.
  const runOf = (tenantId: string, runId: string): MemoryRunRow | undefined =>
    runs.find((run) => run.tenantId === tenantId && run.id === runId)

  const heldRun = (tenantId: string, idempotencyKey: string): MemoryRunRow | undefined =>
    runs.find(
      (run) =>
        run.tenantId === tenantId &&
        run.idempotencyKey === idempotencyKey &&
        (run.status === 'running' || run.status === 'completed'),
    )

  const journal: RunJournal = {
    insertRun: async (params) => {
      const claimed =
        params.idempotencyKey !== null && heldRun(params.tenantId, params.idempotencyKey)

      if (claimed) {
        throw new IdempotencyKeyHeldError({
          tenantId: params.tenantId,
          idempotencyKey: params.idempotencyKey as string,
        })
      }

      const id = `run_${runs.length + 1}`
      runs.push({
        id,
        status: 'running',
        cancelRequested: false,
        startedAt: now(),
        ...params,
        parentRunId: params.parentRunId ?? null,
      })

      return id
    },
    recordStep: async (params) => {
      const written = steps.some(
        (step) =>
          step.runId === params.runId && step.seq === params.seq && step.attempt === params.attempt,
      )
      if (!written) steps.push({ ...params })

      const run = runOf(params.tenantId, params.runId)

      return { cancellationRequested: run?.cancelRequested ?? false }
    },
    requestCancellation: async (params) => {
      const run = runOf(params.tenantId, params.runId)
      if (!run || run.status !== 'running') return false

      run.cancelRequested = true

      return true
    },
    finishRun: async (params) => {
      // Refused before anything is touched, which is what a store with one atomic write does:
      // either the run closed and its events are queued, or neither happened.
      if (outboxWritesFail && (params.events?.length ?? 0) > 0) {
        throw new Error('the outbox is unwritable')
      }

      finishes.push({
        runId: params.runId,
        status: params.status,
        output: params.output,
        error: params.error ?? null,
        events: params.events ?? [],
      })
      // Idempotent on the envelope's own id, exactly as the contract requires of a real table:
      // a finish that runs a second time for the same run writes the same ids, and the second
      // write must land on rows that already exist.
      for (const event of params.events ?? []) {
        if (outbox.some((existing) => existing.id === event.id)) continue

        outbox.push(event)
      }

      // A durable run's row was opened before the instance existed, so the row this journal
      // knows about may legitimately be absent — the update simply lands on the one row the
      // real table has.
      const run = runs.find((candidate) => candidate.id === params.runId)
      if (!run) return

      run.status = params.status
      run.output = params.output
      run.error = params.error ?? null
    },
    markEventsDispatched: async (params) => {
      dispatched.push(...params.ids)
    },
    listUndispatchedEvents: async (params) =>
      outbox
        .filter((event) => !dispatched.includes(event.id) && event.occurredAt <= params.before)
        .toSorted((left, right) => left.occurredAt - right.occurredAt)
        .slice(0, params.limit)
        .map((envelope) => ({ tenantId: envelope.tenantId, envelope })),
    listAbandonedRuns: async (params) =>
      runs
        .filter(
          (run) =>
            run.execution === params.execution &&
            run.status === 'running' &&
            run.startedAt < params.startedBefore,
        )
        .slice(0, params.limit)
        .map((run) => ({ tenantId: run.tenantId, runId: run.id, name: run.name })),
    findRunByIdempotencyKey: async (params) => {
      const run = heldRun(params.tenantId, params.idempotencyKey)

      return run ? { id: run.id, status: run.status, output: run.output } : null
    },
  }

  return {
    journal,
    runs,
    steps,
    finishes,
    outbox,
    dispatched,
    breakOutboxWrites: (): void => {
      outboxWritesFail = true
    },
  }
}

export type MemorySink = {
  sink: EventSink
  /** Every message that travelled, flattened. */
  sent: EventEnvelope[]
  /** One entry per `sendBatch` call, so a suite can ask how many calls a drain made. */
  batches: EventEnvelope[][]
}

/**
 * A sink that remembers. One entry per `sendBatch` call, so a suite can ask how many calls a
 * drain made as well as what travelled in them.
 */
export const createMemorySink = (options: { refuses?: boolean } = {}): MemorySink => {
  const sent: EventEnvelope[] = []
  const batches: EventEnvelope[][] = []

  const sink: EventSink = {
    sendBatch: async (messages) => {
      if (options.refuses) throw new Error('the sink is unreachable')

      const bodies = messages.map((message) => message.body)
      batches.push(bodies)
      sent.push(...bodies)
    },
  }

  return { sink, sent, batches }
}
