import type {
  EventEnvelope,
  EventSink,
  RunJournal,
  RunOutcome,
  RunStatus,
  WorkflowExecution,
} from '../types'

export type MemoryRunRow = {
  id: string
  tenantId: string
  name: string
  execution: WorkflowExecution
  idempotencyKey: string | null
  input: unknown
  status: RunStatus
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
 * The journal a test reaches for, and the worked reference for writing your own: rows in
 * arrays, and the one invariant a real table has to enforce — a single claim per
 * (tenant, idempotency key) — enforced here too, so a suite exercises the engine's behaviour
 * rather than a fixture's convenience.
 */
export const createMemoryJournal = () => {
  const runs: MemoryRunRow[] = []
  const steps: MemoryStepRow[] = []
  const finishes: MemoryFinishRow[] = []
  const outbox: EventEnvelope[] = []
  const dispatched: string[] = []

  // A key is claimed by a run that is still standing — running, or completed and answerable.
  // A run that failed, compensated or was cancelled RELEASES its key, because the work it was
  // asked to do did not happen and asking again is the only way to get it done. A table
  // enforces the same rule with a partial unique index; see src/d1/schema.sql.
  const heldRun = (tenantId: string, idempotencyKey: string) =>
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

      if (claimed) throw new Error('the idempotency key is already held')

      const id = `run_${runs.length + 1}`
      runs.push({ id, status: 'running', ...params })

      return id
    },
    recordStep: async (params) => {
      steps.push({ ...params })
    },
    finishRun: async (params) => {
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
    findRunByIdempotencyKey: async (params) => {
      const run = heldRun(params.tenantId, params.idempotencyKey)

      return run ? { id: run.id, status: run.status, output: run.output } : null
    },
  }

  return { journal, runs, steps, finishes, outbox, dispatched }
}

/**
 * One entry per `sendBatch` call, so a suite can ask how many calls a drain made as well as
 * what travelled in them.
 */
export const createMemorySink = (options: { refuses?: boolean } = {}) => {
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
