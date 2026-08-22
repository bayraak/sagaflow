# Cheat sheet

One screen. Everything else is [the README](../README.md).

## Declare

```ts
import { saga, step, emit, action, actions, sagaflow } from '@bayraak/sagaflow'

const createBooking = saga('booking.create', async (input: { seat: string }) => {
  const seat = await step(
    'reserve',
    () => seats.reserve(input.seat),
    (r) => seats.release(r.id),
  )
  await emit('booking.created', { seatId: seat.id })

  return seat
})

saga(name, body) // inline, no input schema
saga(name, { input, output, idempotent, durable }, body)
```

| Option          |                                                                       |
| --------------- | --------------------------------------------------------------------- |
| `input`         | any Standard Schema — Zod, Valibot, ArkType                           |
| `output`        | validated before the run closes; a refusal undoes the run             |
| `idempotent`    | `true` (hash of the input) or `(input) => string`                     |
| `durable: true` | needed for `sleep`/`waitForEvent`; gives `.start()` instead of a call |

## Call

```ts
await createBooking(input) // the default in-memory instance
await createBooking(input, flow) // an instance you configured
await createBooking(input, flow, { idempotencyKey, parentRunId })
const r = await createBooking.try(input, flow) // { ok, value, runId } | { ok, error }
await chaseInvoice.start(input, flow) // durable
await chaseInvoice.startAll(inputs, flow) // durable, batched
```

## Inside a body

| Verb — **await these**                        |                                       |
| --------------------------------------------- | ------------------------------------- |
| `step(name, run, undo?)`                      | do a thing, and say how to undo it    |
| `step(name, run, { undo, retries, timeout })` | …with a budget                        |
| `emit(type, payload)`                         | announce; held until the run succeeds |
| `sleep(name, '7 days')`                       | durable only                          |
| `waitForEvent(name, { type, timeout })`       | durable only                          |
| **Read — no await**                           |                                       |
| `ctx()`                                       | `{ tenantId, actor, …scope }`         |
| `runId()`                                     | this run                              |
| `idempotencyKey()` · `attempt()`              | inside a step's own function          |

`Promise.all([step(…), step(…)])` is the parallel group. `if`, `for`, `try` are the control flow.
A step you start and forget to `await` fails the run by name.

## Bind the undo to the effect

```ts
const chargeCard = action(cards.charge, { undo: (r) => cards.refund(r.id) })

export const seats = actions(seatService, {
  reserve: { undo: (h) => seatService.release(h.id), announce: (h) => ['seat.reserved', h] },
  release: null, // irreversible, said on purpose
  reads: 'memoise-when-durable', // default; unlisted reads are memoised in a durable saga
  trace: true, // spans for every call; journal rows only for effects
})

const undos = { reserve: fn, sendTicket: null } satisfies UndoSpec<Writes> // total, or it fails
```

Inside a saga: a step. Outside a saga: the plain function. Nested saga: its steps join the
caller's trail as `child/step`.

## Configure

```ts
const flow = sagaflow({ journal, events, eventSchemas, launcher, sagas, observer })
sagaflow.configure({ journal }) // replace the default instance
flow.for({ tenantId, actor, ...extras }) // one scope per request; extras reach ctx()
flow.scope({ tenantId }, () => createBooking(input))
```

## Operate

```ts
await flow.cancel(runId) // cooperative; next step boundary
await flow.inspect(runId) // the run and its trail, as data
await flow.explain(runId) // …as text, or { format: 'mermaid' }
await flow.replay(runId) // a new durable run, keyed on the old one
await flow.run('booking.create', input) // by name, from sagaflow({ sagas })

await sweepEventOutbox({ journal, sink }) // cron, */5
await sweepAbandonedRuns({ journal, olderThanMs: 15 * 60_000 }) // cron, */10
```

## Journals

```ts
createMemoryJournal() · createSqliteJournal(db) · createD1Journal(env.DB)
await journal.migrate()                    // two-minute path; `if not exists` throughout
bunx sagaflow schema > migrations/0001.sql // grown-up path
```

`saga_runs`, `saga_run_steps`, `saga_outbox` — rename with `{ tables }`. Writing your own?
`journalConformance` from `@bayraak/sagaflow/testing` is the contract as executable cases.

## Cloudflare

```ts
export class Sagas extends entrypointFor(flow) {}
export default workerFor(flow, { onEvent, fetch })
```

Bindings: `d1_databases`, `workflows` (`class_name` = your class), `queues` producer + consumer,
`triggers.crons`. `compatibility_flags: ["nodejs_compat"]` is required. Named environments
inherit nothing — repeat every block.

## Outcomes

`completed` · `compensated` (fully undone) · `failed` (an undo refused, or abandoned) ·
`cancelled`. Exactly one `workflow.completed` **or** `workflow.compensated` per closed run.

Undos run in **reverse start order**, every one attempted. A repeated step name is numbered
`name`, `name#2`. Envelope ids are `${runId}:${ordinal}` — deterministic, so a repeat is
recognisable.

## Testing

```ts
const journal = createMemoryJournal()
const flow = sagaflow({ journal: journal.journal, events: createMemorySink().sink })

await createBooking(input, flow)
expect(await trailOf({ journal: journal.journal, runId })).toEqual(['reserve:completed'])
expect(journal.runs[0]).toMatchObject({ status: 'completed' })
```

## Never

- reshape a deployed **durable** saga's steps — version by name (`invoice.send.v2`)
- non-determinism outside a step — `Math.random()`, `Date.now()`, mutable globals
- step outputs over 1 MiB — receipts, not entities (`sizeGuard()` warns)
- `terminate()` on a Cloudflare instance if you want undos — use `flow.cancel`
