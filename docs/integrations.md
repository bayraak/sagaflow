# Integrations

Recipes, not plugins. sagaflow has three seams — journal, sink, step primitive — and framework
glue is deliberately not one of them, because resolving the tenant and the actor is always the
application's job and no middleware can guess how yours does it. See
[`adapters.md`](./adapters.md) for the seams themselves.

Every snippet on this page is marked `// illustrative`: it is written to be read next to your own
code rather than pasted into it, and it is not compiled by the test suite the way the
[README's examples](../README.md) are. The [`examples/`](../examples) directory is the executed
version.

## The one rule: one scope per request

A saga needs to know which tenant it is for and who asked. There are two ways to tell it, and the
first one is never wrong:

```ts
// illustrative — explicit, works on every runtime
await createBooking(input, flow.for({ tenantId: session.orgId, actor: session.userId }))
```

```ts
// illustrative — ambient, when your framework wraps the whole request
await flow.scope({ tenantId: session.orgId, actor: session.userId }, () => handler())
```

`flow.scope` uses `AsyncLocalStorage`, so it needs `node:async_hooks` — present on Node, Bun and
Deno, and on Workers with `nodejs_compat` set. Inside a scope a saga can be called with no second
argument. The explicit argument still wins wherever it is given, so mixing the two is safe.

**The tenant comes from the session, never from the input.** A key derived from a tenant the
caller supplied is not a tenant boundary.

Extra fields on the scope reach every body as `ctx()`:

```ts
// illustrative
await flow.scope({ tenantId, actor, requestId, ip }, () => handler())
// inside any saga or step below this line:
const { requestId } = ctx()
```

## Hono

Hono's middleware returns the downstream promise, which is exactly the shape `flow.scope` wants:

```ts
// illustrative
import { Hono } from 'hono'

const app = new Hono()

app.use('*', async (c, next) => {
  const session = await sessionFrom(c)

  return flow.scope({ tenantId: session.orgId, actor: session.userId }, () => next())
})

app.post('/bookings', async (c) => {
  const result = await createBooking.try(await c.req.json())

  if (!result.ok) return c.json({ error: result.error.message }, 409)

  return c.json(result.value, 201)
})
```

The handler mentions no runtime at all. That is the point of the middleware: a route that forgets
to pass the scope is a route that cannot compile a tenant into a key by accident.

## tRPC

Same shape, one middleware, and then every mutation in the router is inside a scope:

```ts
// illustrative
const sagaScope = t.middleware(({ ctx, next }) =>
  flow.scope({ tenantId: ctx.session.orgId, actor: ctx.session.userId }, () => next()),
)

const mutation = t.procedure.use(sagaScope)

export const bookingRouter = t.router({
  create: mutation.input(bookingInput).mutation(({ input }) => createBooking(input)),
})
```

If you want this to be structural rather than a convention, make the saga part of the procedure
builder instead of the resolver: a `sagaProcedure` whose resolver body _is_ the saga body, named
after the tRPC path. Then every mutation in the router is a recorded, undoable, idempotent run
because there is no other way to write one. That is the pattern the production application this
was extracted from uses.

## Next.js server actions

There is no middleware seam around a server action, so wrap the ones that mutate:

```ts
// illustrative
const inScope = async <T>(body: () => Promise<T>): Promise<T> => {
  const session = await auth()

  return flow.scope({ tenantId: session.orgId, actor: session.userId }, body)
}

export async function createBookingAction(form: FormData) {
  'use server'

  return inScope(() => createBooking({ seat: String(form.get('seat')) }))
}
```

Two notes specific to Next.js. Sagas are server-only — keep the module out of anything a client
component imports. And a server action that revalidates should do it **after** the run returns,
not inside a step: revalidation is not an effect the run can undo, and a compensated run should
not have invalidated a cache on the strength of a change that was rolled back.

## Express and Fastify

Neither gives you a handler that wraps the whole request, so pass the scope explicitly. This is
the form that is never wrong:

```ts
// illustrative
app.post('/bookings', async (req, res) => {
  const scoped = flow.for({ tenantId: req.session.orgId, actor: req.session.userId })
  const result = await createBooking.try(req.body, scoped)

  if (!result.ok) return res.status(409).json({ error: result.error.message })

  return res.status(201).json(result.value)
})
```

If you already run an `AsyncLocalStorage` store per request — many Express and Fastify codebases
do, for request ids and logging — put `flow.for(...)` in it and read it back where you call the
saga. Do not open a second one.

## Elysia

Elysia's `derive` builds per-request context, which is the scope:

```ts
// illustrative
new Elysia()
  .derive(({ headers }) => ({ scoped: flow.for(sessionFrom(headers)) }))
  .post('/bookings', async ({ body, scoped, set }) => {
    const result = await createBooking.try(body, scoped)

    if (!result.ok) {
      set.status = 409

      return { error: result.error.message }
    }

    return result.value
  })
```

## Cloudflare Workers

The flagship, and the shortest of these. A whole worker is an entrypoint class and a handler
object:

```ts
// illustrative
export class Sagas extends entrypointFor(flow) {}

export default workerFor(flow, {
  onEvent: (envelope) => audit.append(envelope),
  fetch: async (request) => {
    /* your routes */
  },
})
```

`entrypointFor` reads the registry and the runtime off the instance, so durable sagas dispatch by
name. `workerFor` adds the two handlers every sagaflow worker needs — a queue consumer for the
outbox and a scheduled handler that runs both sweepers — around your own `fetch`.

### Fan-out

Cloudflare rate-limits instance creation per second, so starting a hundred durable runs one call
at a time is a hundred round trips against a counter designed to stop you. Start them together
instead:

```ts
// illustrative
await chaseInvoice.startAll(overdue, flow, { parentRunId: runId() })
```

`startAll` opens every run record first — so a batch the platform refuses still leaves something
behind that explains itself — validates every input before it opens any of them, answers inputs
whose idempotency key is already held from the run that holds it, and then uses the launcher's
`createBatch` where the binding has one, falling back to one call each where it does not.
`startDurableWorkflows` is the same thing at the lower level, for a definition you are holding
directly.

### Catching an output too big to checkpoint

A durable platform will not checkpoint a step output over a mebibyte. Cloudflare finds out at
runtime, in production, on the first run whose data was finally large enough — which is a bad
place to learn it. Install the guard in development instead:

```ts
// illustrative
import { sizeGuard } from '@bayraak/sagaflow'

const flow = sagaflow({ journal, events, observer: sizeGuard() })
```

It warns rather than throwing, and it is an observer rather than a rule in the engine because
measuring costs a serialisation per step and only the people who asked should pay for it. The
zero-configuration development instance installs it for you. The habit it teaches is the real
fix: return a receipt, put the bytes in object storage.

The bindings, the two crons, the `nodejs_compat` requirement, the Rules of Workflows table, the
platform limits and what a deploy costs are all in [`cloudflare.md`](./cloudflare.md).
[`examples/cloudflare-worker`](../examples/cloudflare-worker) is the copyable template, and its
tests run against real workerd with local D1, Queues and Workflows.

## ORMs and query builders

**Bring your ORM's executor; we bring the SQL.**

sagaflow writes three tables and never needs an ORM. `createSqlJournal` holds every statement and
asks for three methods:

```ts
// illustrative — the whole contract
type SqlDriver = {
  run(statement: { sql: string; params: unknown[] }): Promise<{ changes: number }>
  all<Row>(statement: { sql: string; params: unknown[] }): Promise<Row[]>
  batch(statements: { sql: string; params: unknown[] }[]): Promise<unknown[][]> // ATOMIC
}
```

`batch` is the load-bearing one: all of the statements or none of them. If a driver's batch is not
atomic, "run completed with its events lost" becomes representable again — which is the one thing
the engine promises cannot happen.

Most people need no driver at all, because the shipped ones already wrap the thing underneath
their ORM:

| You use                                    | Do this                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Drizzle on D1                              | `createD1Journal(env.DB)` — pass the binding, not the Drizzle instance. Drizzle keeps owning your own tables. |
| Drizzle on `bun:sqlite` / `better-sqlite3` | `createSqliteJournal(sqlite)` with the same underlying database handle.                                       |
| Prisma, Kysely, or a raw pool              | A ten-line `SqlDriver` over their raw-query escape hatch (below).                                             |
| Something that is not SQL                  | A whole `RunJournal`. See [`adapters.md`](./adapters.md#when-you-do-need-a-whole-journal).                    |

A driver over a query builder, in full:

```ts
// illustrative — Kysely
const driver: SqlDriver = {
  run: async ({ sql, params }) => {
    const result = await db.executeQuery(CompiledQuery.raw(sql, params))

    return { changes: Number(result.numAffectedRows ?? 0) }
  },
  all: async ({ sql, params }) => (await db.executeQuery(CompiledQuery.raw(sql, params))).rows,
  batch: (statements) =>
    db.transaction().execute(async (trx) => {
      const rows: unknown[][] = []

      // In order, not in parallel: the contract promises the rows each statement answered, in
      // the order they were given.
      for (const { sql, params } of statements) {
        rows.push((await trx.executeQuery(CompiledQuery.raw(sql, params))).rows)
      }

      return rows
    }),
}
```

Prisma is the same three lines over `$queryRawUnsafe`, `$executeRawUnsafe` and `$transaction([…])`.

**One landmine, and it is silent.** `db.transaction()` on Cloudflare D1 type-checks and throws at
runtime — D1 has no interactive transactions. On D1 the atomic unit is `db.batch`, which is
exactly why the contract asks for a batch rather than a transaction. If you are writing a driver
for a platform where both exist, use the transaction; if only a batch exists, check that it is
actually atomic before shipping it.

### The DDL

The schema is three tables and it is yours. There are three ways to get the SQL; pick by how much
ceremony the moment deserves.

**A command, for your migration tool.** No dependency, nothing imported from your project:

```bash
bunx sagaflow schema > migrations/0001_sagaflow.sql
bunx sagaflow schema --dialect d1 --tables runs=flow_runs,steps=flow_steps,outbox=flow_outbox
```

`--dialect` takes `sqlite` or `d1` (D1 is SQLite), `--format` takes `sql`, and `--tables` renames
the tables to match whatever you pass `createSqlJournal`.

**A module, when you generate migrations from code:**

```ts
// illustrative
import { schemaFor, schemaSql } from '@bayraak/sagaflow/sql'

writeFileSync('migrations/0001_sagaflow.sql', schemaSql)

// renamed tables? the SQL follows the names you pass the journal
const statements = schemaFor({
  runs: 'workflow_runs',
  steps: 'workflow_run_steps',
  outbox: 'event_outbox',
})
```

**`migrate()`, for a test or a script.** `createSqlJournal`, `createSqliteJournal` and
`createD1Journal` all return one, and it creates the tables if they are not there. Every statement
is `if not exists`, so calling it twice is calling it once. It is the two-minute path; your
migration tool is the grown-up one for anything else.

Rename the tables in the DDL and pass the same names through the journal's `tables` option, and
the engine and your schema agree. sagaflow does not own your schema.

### Proving your adapter

Do not write your own suite. `journalConformance` from `@bayraak/sagaflow/testing` is the contract
as executable cases, runnable under bun, vitest, node:test or jest unchanged —
[`adapters.md`](./adapters.md#proving-a-journal) has the wiring.

## Queues and sinks

A sink is one method:

```ts
// illustrative
type EventSink = { sendBatch(messages: { body: EventEnvelope }[]): Promise<unknown> }
```

**A Cloudflare Queue binding satisfies it structurally.** Pass `env.EVENTS` as `events` and there
is no adapter, no wrapper and no glue.

Everything else is five lines:

```ts
// illustrative — SQS
const sink: EventSink = {
  sendBatch: (messages) =>
    sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: url,
        Entries: messages.map(({ body }) => ({ Id: body.id, MessageBody: JSON.stringify(body) })),
      }),
    ),
}
```

```ts
// illustrative — pg-boss
const sink: EventSink = {
  sendBatch: (messages) =>
    boss.insert(messages.map(({ body }) => ({ name: body.type, data: body }))),
}
```

And no queue at all is a supported answer. `createInProcessSink(handler)` from
`@bayraak/sagaflow/memory` calls your handler directly; the outbox table plus the sweeper is then
the whole delivery mechanism, at-least-once like any other. Without any sink the events simply
stay in the outbox until something reads them, which is also fine — the journal is the only hard
requirement.

**Whatever the sink, dedupe at the consumer on `envelope.id`.** Delivery is at-least-once by
design; a unique index on the id in whatever table the consumer writes is the usual way. On
Workers, `handleQueue({ seen })` takes the check as a callback.

## A StepPrimitive is twenty lines

Durable mode needs one thing from a platform:

```ts
// illustrative
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

Three capabilities, and most durable platforms have all three under other names. Inngest is a 1:1
shape match, which is why it is the next adapter:

| sagaflow                          | Inngest                                 |
| --------------------------------- | --------------------------------------- |
| `do(name, config, run)`           | `step.run(name, run)`                   |
| `sleep(name, duration)`           | `step.sleep(name, duration)`            |
| `waitForEvent(name, { type, … })` | `step.waitForEvent(name, { event, … })` |
| memoised by name within a run     | memoised by name within a run           |
| `attempt` rising across retries   | `attempt` on the function's run context |

Restate (`ctx.run` / `ctx.sleep` / awakeables), Temporal activities and Vercel's Workflow DevKit
are the same three capabilities with different spellings. The contract an adapter must honour —
memoise by name, re-answer on replay without running the callback, survive the platform's
serialisation — is in [`adapters.md`](./adapters.md#writing-a-step-primitive).

## Agents and MCP tools

**Reads run, writes propose.**

An agent taking actions on a real system has a backend's problem, louder: it will retry, it will
be interrupted, and somebody will ask afterwards what it did.

- **A write tool is a saga.** Every effect declares its undo, so a half-finished plan can be
  reversed rather than explained. `idempotent: true` makes the same request asked twice one run,
  however many times the agent retries.
- **A read tool is not a saga**, because reading changes nothing. `flow.inspect(runId)` answers
  with the run, its status and its trail as data; `flow.explain(runId)` renders the same thing for
  a person, as text or as a Mermaid diagram (`{ format: 'mermaid' }`). Both read your own tables,
  so "what happened to invoice 4021" is answered from rows rather than from a context window —
  and the diagram is generated from the run record, so it works for inline runs and on every
  substrate.
- **Irreversible actions become proposals.** A step that writes a proposal is undoable; a step
  that sends the money is not. Put the point of no return in a separate durable saga that waits
  on `waitForEvent` for a human, and let the run record show everything that led up to it.

[`examples/agent-tools`](../examples/agent-tools) is all three as running code.

## Something else?

The seams are the extension surface, and a new adapter is a small file rather than a plugin
registration. If you write one — a journal for a store not listed here, a sink, a step primitive
for another platform — [`adapters.md`](./adapters.md) is the contract and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) is how to send it.

For the API itself rather than the wiring, [`cheatsheet.md`](./cheatsheet.md) is the one-screen
version and [`positioning.md`](./positioning.md) is the argument for using any of this at all.
