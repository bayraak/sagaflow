# The `RunJournal` contract

Nine methods. The shape is checked by TypeScript; the **behaviour** is what the engine relies on
absolutely, and that is what this page is about — and what
[`journalConformance`](./adapters.md#proving-a-journal) enforces.

Shipped adapters: `sagaflow-js/memory`, `sagaflow-js/sql` (with `sagaflow/d1` and `sagaflow-js/sqlite`
drivers). The reference DDL is [`src/sql/schema.sql`](../src/sql/schema.sql).

## Getting them in place

```ts
await createSqliteJournal(db).migrate()
```

Every statement is `if not exists`, so running it twice is running it once — which matters
because the honest place to call it is at the top of a process or in a test's setup, where nobody
is tracking whether it has run before. It honours renamed tables, since creating tables the
journal never writes to would be worse than creating none.

For a real migration tool, the same SQL as a file:

```bash
bunx sagaflow schema > migrations/0001_sagaflow.sql
bunx sagaflow schema --tables runs=flow_runs,steps=flow_steps,outbox=flow_outbox
```

D1 is SQLite, so `--dialect d1` and `--dialect sqlite` print the same DDL.

## The three tables

`saga_runs`, `saga_run_steps`, `saga_outbox` by default; pass `tables` to `createSqlJournal` if
your schema calls them something else. sagaflow does not own your schema — your migration tool
does.

| Table            | Holds                                                                                                        | The index that matters                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `saga_runs`      | one row per run: status, input, output, error, the run it replays, the run it came from, a cancellation flag | **partial** unique on `(tenant_id, idempotency_key) WHERE status IN ('running','completed')` |
| `saga_run_steps` | one row per attempt of every step and every undo                                                             | unique on `(run_id, seq, attempt)`                                                           |
| `saga_outbox`    | one row per emitted event, the whole envelope as it will travel                                              | `(dispatched_at, created_at)`                                                                |

The partial index is the single most important line in the schema. A plain unique index would
lock the door behind every failure: an invoice whose send fell over could never be sent again.

## `insertRun`

```ts
insertRun(params: {
  tenantId: string
  name: string
  execution: 'durable' | 'inline'
  idempotencyKey: string | null
  input: unknown
  replayOf?: string | null
  parentRunId?: string | null
}): Promise<string>
```

Opens a run as `running` and answers with its id.

**MUST throw when the key is already HELD** — that is, when a run with the same
`(tenantId, idempotencyKey)` is `running` or `completed`. The throw _is_ the dedup signal. The
engine answers it by looking the holder up rather than doing the work twice, so a journal that
swallowed the conflict would turn a duplicate into a silent second execution.

**Should throw `IdempotencyKeyHeldError`.** A typed refusal lets the engine tell "this key is
taken" apart from "the database is on fire", which is what makes the one honest retry safe:
between the refusal and the lookup, the holder can finish badly and release the key, and asking
again is right exactly once. Journals that throw something else still work; they just give the
engine less to go on.

`parentRunId` is provenance and nothing more. The engine reads no meaning into it, walks no tree
and enforces no rule.

## `recordStep`

```ts
recordStep(params: {
  tenantId: string
  runId: string
  seq: number
  name: string
  status: 'compensated' | 'completed' | 'failed'
  attempt: number
  output?: unknown
  error?: string | null
}): Promise<{ cancellationRequested: boolean }>
```

**Idempotent on `(runId, seq, attempt)`** — the same attempt written twice is one row.

**Answers with the run's cancellation flag, in the same round trip.** This is why cooperative
cancellation is free: the engine already had to talk to the journal here, so noticing that
somebody asked the run to stop costs nothing extra. On D1 this is one `batch` of an insert and a
select.

A write per step is deliberate. Buffering them would be cheaper and would lose exactly the thing
the trail is for — a partial trail after a crash.

## `finishRun`

```ts
finishRun(params: {
  tenantId: string
  runId: string
  status: 'cancelled' | 'compensated' | 'completed' | 'failed'
  output?: unknown
  error?: string | null
  events?: EventEnvelope[]
}): Promise<void>
```

**ONE atomic write.** Closing the run and writing its events are one call because they are one
batch underneath: a run is `completed` if and only if its events are durably queued. A journal
that took them separately could be interrupted between the two, and "completed, audit trail lost"
is the state that must not exist.

**Outbox inserts are idempotent on envelope id**, which is what makes the whole call safe to
repeat with the same arguments — the case a durable re-invocation actually produces.

**Only a run that is still `running` is closed.** A run the sweeper already closed has released
its key and somebody else may hold it now; letting a late finish re-enter the held set is a
uniqueness violation thrown from inside a step. Whoever closed the run first decided how it
ended.

## `markEventsDispatched`

```ts
markEventsDispatched(params: { tenantId: string; ids: string[] }): Promise<void>
```

Stamps what was delivered so nothing sweeps it again. Failing this is survivable: the sweeper
re-sends and the consumer recognises the message by its id.

## `findRunByIdempotencyKey`

```ts
findRunByIdempotencyKey(params: {
  tenantId: string
  idempotencyKey: string
}): Promise<{ id: string; status: RunStatus; output: unknown } | null>
```

**Held runs only**, by the same rule `insertRun` refuses by. A run that failed, compensated or
was cancelled is not an answer to "who holds this key" — it released it.

## `requestCancellation`

```ts
requestCancellation(params: { tenantId: string; runId: string }): Promise<boolean>
```

Raises the flag. **True only if the run was `running`** — a run that has already ended cannot be
stopped, and saying so is more useful than pretending.

## `listUndispatchedEvents`

```ts
listUndispatchedEvents(params: {
  before: number
  limit: number
}): Promise<{ tenantId: string; envelope: EventEnvelope }[]>
```

Oldest first, **across every tenant** — the one method in the contract that is deliberately not
tenant-scoped, because nobody is asking on a tenant's behalf. `before` is compared against the
envelope's `occurredAt`, which is what the row's `created_at` is set from.

## `listAbandonedRuns`

```ts
listAbandonedRuns(params: {
  execution: 'inline'
  startedBefore: number
  limit: number
}): Promise<{ tenantId: string; runId: string; name: string }[]>
```

The inline runs still `running` from before the cutoff. A list rather than a bulk update, because
closing a run is not only a status change: every closed run announces itself, and an
announcement needs the run's name and its tenant. `sweepAbandonedRuns` closes each one through
`finishRun`, like everything else that closes a run.

Durable runs are never asked for. One may legitimately be asleep for a week.

## The envelope

```ts
type EventEnvelope = {
  id: string // `${runId}:${ordinal}` — deterministic
  type: string
  payload: unknown
  tenantId: string
  actor: string | null
  runId: string | null
  occurredAt: number
}
```

Stored whole, as JSON, so a sweep sends exactly what the run emitted rather than rebuilding it
from columns years later.

## Two facts the engine always emits

| Event                  | When                                    | Payload                           |
| ---------------------- | --------------------------------------- | --------------------------------- |
| `workflow.completed`   | the run finished                        | `{ runId, name }`                 |
| `workflow.compensated` | the run was undone, failed or cancelled | `{ runId, name, error, outcome }` |

Exactly one per closed run — including runs the sweeper closes and runs whose platform refused to
start them. A workflow that tries to emit one of these names is refused.

## Run inputs are receipts, not corpora

The input is stored on the run row and read back on a dedup answer. Keep it small: ids, amounts,
short strings. A run whose input is an entire imported spreadsheet is a row you cannot list, a
dedup answer you cannot afford, and a backup that grows without limit. Put the corpus in object
storage and pass the key. The same goes for step outputs — Cloudflare caps a step's output at
1 MB, and that cap is a good instinct everywhere.
