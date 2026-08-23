# Adapters

The extension surface is three seams and nothing else. No plugin system, no `withSagaflow`
wrapper, no lifecycle hooks to register — an adapter is a small file that implements one
contract.

| Seam            | Contract                                                                                 | Shipped                                                                        | Obvious next                                       |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| `RunJournal`    | [journal.md](./journal.md)                                                               | `sagaflow-js/memory`, `sagaflow-js/sql` + `sagaflow/d1` + `sagaflow-js/sqlite` | Postgres, libSQL/Turso, Durable Object storage     |
| `EventSink`     | `{ sendBatch(messages: { body: EventEnvelope }[]): Promise<unknown> }`                   | a Cloudflare Queue binding **is** one; `createMemorySink`                      | SQS, pg-boss, an in-process bus                    |
| `StepPrimitive` | `{ do(name, config, fn), sleep(name, duration), waitForEvent(name, { type, timeout }) }` | `sagaflow-js/cloudflare`                                                       | Inngest, Restate, Temporal, Vercel Workflow DevKit |

Framework glue is deliberately _not_ a seam. Resolving the tenant and the actor is always the
application's job, so integration stays recipes rather than middleware.

## Writing a journal

Most stores do not need a new journal at all — they need a **driver**. `createSqlJournal` holds
all the SQL and asks for three things:

```ts
type SqlDriver = {
  run(statement: { sql: string; params: unknown[] }): Promise<{ changes: number }>
  all<Row>(statement: { sql: string; params: unknown[] }): Promise<Row[]>
  batch(statements: { sql: string; params: unknown[] }[]): Promise<unknown[][]> // ATOMIC
}
```

`batch` is the load-bearing one. All of the statements or none of them, and the rows each one
answered, in order. On D1 that is `db.batch`; elsewhere it is a transaction. If a driver's batch
is not atomic, "completed with its audit trail lost" becomes representable again.

The whole D1 driver:

```ts
export const createD1Driver = (db: D1Database): SqlDriver => {
  const prepare = ({ sql, params }) =>
    params.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...params)

  return {
    run: async (statement) => ({ changes: (await prepare(statement).run()).meta.changes }),
    all: async (statement) => (await prepare(statement).all()).results,
    batch: async (statements) =>
      (await db.batch(statements.map(prepare))).map((result) => result.results),
  }
}
```

Bring your ORM's executor and you are done — every ORM exposes these three underneath.

### When you do need a whole journal

For a store that is not SQL — Redis, DynamoDB, MongoDB, Durable Object storage — implement
`RunJournal` directly. `src/memory/index.ts` is the worked reference: it enforces every rule a
real table enforces rather than taking the convenient shortcuts, precisely so it is worth reading
as a model.

### Which stores suit this

| Store                                     | Suitable?            | Why                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL (SQLite, D1, Postgres, MySQL, libSQL) | **Yes, the default** | A partial unique index and an atomic multi-statement write are exactly what the contract asks for                                                                                                                                                                          |
| Redis                                     | Yes, with care       | `MULTI`/Lua gives atomicity; the key-held rule is a `SET NX` on a derived key; the outbox sweep wants a sorted set                                                                                                                                                         |
| DynamoDB                                  | Yes                  | `TransactWriteItems` covers the finish; a conditional put covers the held key; a GSI covers the sweep                                                                                                                                                                      |
| MongoDB                                   | Yes                  | Multi-document transactions cover the finish; a partial unique index exists natively                                                                                                                                                                                       |
| Durable Object storage                    | Yes, per tenant      | Storage writes in one event loop turn are atomic; one object per tenant makes the key rule local                                                                                                                                                                           |
| **Plain KV**                              | **No**               | Eventually consistent with no conditional write and no atomic multi-key write. The held-key rule and the atomic finish are both unimplementable, and the failures are silent: two runs both believing they hold a key, and runs completing with their events lost. Do not. |

## Writing a sink

```ts
type EventSink = { sendBatch(messages: { body: EventEnvelope }[]): Promise<unknown> }
```

One method, on purpose. A run emits several events and a sweep delivers many; one call per
message was a round trip per event on the mutation path. A batch of one is a batch.

A Cloudflare Queue binding satisfies this structurally — no adapter at all. For anything else:

```ts
const sink: EventSink = {
  sendBatch: async (messages) => {
    await bus.publish(messages.map((message) => message.body))
  },
}
```

A sink is allowed to throw. The drain catches it, the rows stay unstamped, and the sweeper
carries them — which is the entire reason the outbox exists.

## Writing a step primitive

```ts
type StepPrimitive = {
  do<Output>(
    name: string,
    config: StepRetryConfig,
    run: (ctx: { attempt: number }) => Promise<Output>,
  ): Promise<Output>
  sleep(name: string, duration: string): Promise<void>
  waitForEvent<Payload>(name: string, options: { type: string; timeout?: string }): Promise<Payload>
}
```

Three capabilities, and most durable platforms have all three under other names. The contract the
adapter must honour:

- `do` memoises by **name** within a run and re-answers on a replay without running the callback.
- `do` may call the callback more than once, with a rising `attempt`.
- Anything the callback returns must survive the platform's serialisation — the engine puts the
  step's output, its compensation value and its emitted events in there.

The Cloudflare adapter is about forty lines. Inngest's `step.run` / `step.sleep` /
`step.waitForEvent` is the same shape.

## Proving a journal

Do not write your own suite. `sagaflow-js/testing` exports the contract as an executable one:

```ts
import { journalConformance } from 'sagaflow-js/testing'

const cases = journalConformance(() => ({
  journal: createMyJournal(store),
  runStatus: async ({ tenantId, runId }) => /* one query */,
  countSteps: async ({ runId }) => /* one query */,
  breakOutboxWrites: () => /* make outbox writes fail from now on */,
}))

for (const c of cases) it(c.name, c.run)
```

It is runner-agnostic by construction — cases are named functions that throw — so bun, vitest,
node:test and jest all run it unchanged. Thirty-seven cases covering the key-held rule, the
release rule, step idempotency, the cancellation round trip, sweep ordering and filtering, and
the one that needs your store broken on purpose: a finish that cannot write its events must not
close the run either.

The three shipped journals answer all of them. Yours should too.
