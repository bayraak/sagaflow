# Cloudflare

Durable mode runs on Cloudflare Workflows. Inline mode runs on Workers with nothing extra.

## The whole worker

```ts
import { env } from 'cloudflare:workers'
import { sagaflow } from 'sagaflow-js'
import { createD1Journal } from 'sagaflow-js/d1'
import { entrypointFor, workerFor } from 'sagaflow-js/cloudflare'

import { createBooking, chaseInvoice } from './sagas'

const flow = sagaflow({
  journal: createD1Journal(env.DB),
  events: env.EVENTS,
  launcher: env.WORKFLOWS,
  sagas: [createBooking, chaseInvoice],
})

export class Sagas extends entrypointFor(flow) {}

export default workerFor(flow, {
  onEvent: (envelope) => audit.append(envelope),
  fetch: async (request) => {
    /* your routes */
  },
})
```

`entrypointFor` reads the registry and the runtime from the instance. `workerFor` adds the two
handlers every sagaflow worker needs — a queue consumer for the outbox, and a scheduled handler
that runs both sweepers — around your own `fetch`.

## A scope built from env

`import { env } from 'cloudflare:workers'` is enough while the scope is just the bindings. It is
not enough as soon as the scope carries things you build out of them — a database client, its
query helpers, an API client with a key from a secret — because inside a durable instance there
is no request and no module-scope moment that has your bindings. There is `this.env`, handed to
the class per invocation.

So both take a factory:

```ts
import { entrypointFor, workerFor } from 'sagaflow-js/cloudflare'

const createFlow = (env: Env) => {
  const db = drizzle(env.DB)

  return sagaflow({
    journal: createD1Journal(env.DB),
    events: env.EVENTS,
    launcher: env.WORKFLOWS,
    sagas: [createBooking, chaseInvoice],
  }).for({ db, queries: queriesFor(db) })
}

export class Sagas extends entrypointFor((env: Env) => createFlow(env)) {}

export default workerFor((env: Env) => createFlow(env), { onEvent, fetch })
```

The factory is called for every run — a database client it opens belongs to the invocation that
opened it, and the platform refuses it from the next one — and the entrypoint then adds the
tenant and the actor of the run it was invoked for. Only the registry, which is pure, is kept. `ctx()` inside the body sees all of it:

```ts
const { db, queries, tenantId, actor } = ctx<{ db: Db; queries: Queries }>()
```

Adding, not replacing: `for` merges over the scope it is called on, so the layer that knows the
bindings and the layer that knows who is asking do not have to know about each other. That is
also what makes the request path work — `flow.for({ tenantId, actor })` in a route keeps
everything the module-scope instance was built with.

## Bindings

```jsonc
{
  "main": "src/index.ts",
  "compatibility_date": "2026-08-15",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{ "binding": "DB", "database_name": "your-db", "database_id": "…" }],
  "workflows": [{ "name": "your-sagas", "binding": "WORKFLOWS", "class_name": "Sagas" }],
  "queues": {
    "producers": [{ "binding": "EVENTS", "queue": "your-events" }],
    "consumers": [{ "queue": "your-events", "max_batch_size": 10, "max_retries": 3 }],
  },
  "triggers": { "crons": ["*/5 * * * *"] },
}
```

`nodejs_compat` is required: the ambient verbs use `AsyncLocalStorage`, which is the only thing
that answers "which saga am I in" correctly when two runs are in flight at once.

## Dispatching from your own entrypoint

`entrypointFor` is `createWorkflowEntrypoint` with the registry and the runtime taken from an
instance, and both of those accept a function of env too. If you need the class itself —
different dispatch, extra instrumentation, a `WorkflowEntrypoint` subclass of your own —
`definitionOf(saga)` gives you what a durable saga was built from, and `undefined` for an inline
one, which has no instance to start.

**Named environments inherit nothing.** Every binding has to be repeated in every `env` block. A
binding missing from one of them is a deploy that works in dev and fails in production.

Apply the schema with your migration tool — `wrangler d1 migrations apply` and a migration
containing [`src/sql/schema.sql`](../src/sql/schema.sql).

## What it costs you

- **Local development and the whole test suite need no Cloudflare account and no credentials.**
- Deploying needs an account; the Workers **Paid** plan only if you use Queues.
- Authenticate with `wrangler login`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Create resources from the CLI: `wrangler d1 create <name>` (paste the `database_id` into
  `wrangler.jsonc`), `wrangler queues create <name>`, then `wrangler d1 migrations apply` and
  `wrangler deploy`.
- **sagaflow itself needs no secret, no key and no account of any kind.**

## The Rules of Workflows

Cloudflare publishes a set of rules for writing Workflows. Here is every one, and who keeps it.

| Rule                                              | Who keeps it                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wrap every I/O and side effect in a step          | **You.** `step()` is the wrapper; the engine cannot see an unwrapped `await fetch()`.                                                                              |
| Make steps granular — one thing each              | **You.** A step is the unit of retry and the unit of undo.                                                                                                         |
| Do not rely on state outside a step               | **You.** A durable body re-runs from the top; only step results come back.                                                                                         |
| Keep code outside steps deterministic             | **You.** `Math.random()`, `Date.now()` and reads of mutable module state belong inside a step.                                                                     |
| Step names must be unique within an instance      | **Shared.** The engine refuses a duplicate name at runtime rather than letting it be silently wrong; you still have to name fan-out per item.                      |
| Never change the name or order of a deployed step | **You**, with help: [versioning.md](./versioning.md) says what to do instead, and the engine's own steps (`finish-run`, `emit-events`, `compensate:*`) never move. |
| Step return values must be serialisable, ≤ 1 MiB  | **You.** Return receipts, not entities. The engine puts a step's value, its undo data and its emitted events in that budget.                                       |
| Use `step.sleep` rather than a timer              | **Engine.** `sleep()` is `step.sleep`; there is no other way to wait.                                                                                              |
| Configure retries per step                        | **Engine.** `retries` and `timeout` on a step reach the platform untouched.                                                                                        |
| Instance ids must be unique and ≤ 100 chars       | **Engine.** `instanceIdFor(name, runId)`, always legal, always per run.                                                                                            |
| Do not create instances faster than the limit     | **You.** Batch with the launcher, or queue the work.                                                                                                               |
| Handle `waitForEvent` timeouts                    | **You.** A timeout throws, which compensates the run — decide whether that is what you want.                                                                       |
| Terminating an instance does not run your cleanup | **Engine, if you ask it to.** `terminate()` is a hard kill. `flow.cancel(runId)` unwinds through the undo chain and closes the run record honestly.                |

## Limits

From Cloudflare's reference, checked 2026-08-22. Each row links to the sagaflow rule it drives.

| Limit                  | Free       | Paid                              | What it means here                                                                                        |
| ---------------------- | ---------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Step result size       | 1 MiB      | 1 MiB                             | Receipts, not entities. A dev-mode guard warns before you find out in production.                         |
| Event payload size     | 1 MiB      | 1 MiB                             | Same rule for what an announcement carries.                                                               |
| Sleep duration         | 365 days   | 365 days                          | A run may legitimately be open for a year — which is why the abandoned sweep never touches a durable run. |
| Steps per workflow     | 1,024      | 10,000 (to 25,000)                | The engine adds two per run (`finish-run`, `emit-events`) plus one per undo.                              |
| Concurrent instances   | 100        | 50,000                            | Only `running` counts; `waiting` is free. A saga that sleeps costs nothing while it sleeps.               |
| Instance creation rate | 100/s      | 300/s account, 100/s per workflow | Batch or queue beyond that.                                                                               |
| Queued instances       | 100,000    | 2,000,000                         |                                                                                                           |
| Instance id length     | 100 chars  | 100 chars                         | `instanceIdFor` truncates the name, never the run id.                                                     |
| Workflow binding name  | 64 chars   | 64 chars                          |                                                                                                           |
| CPU per step           | 10 ms      | 30 s                              | A step is one batch or one call, not a compute job.                                                       |
| Retries per step       | 10,000     | 10,000                            |                                                                                                           |
| **State retention**    | **3 days** | **30 days**                       | **The journal outlives Cloudflare's retention; that is one reason it exists.**                            |

## The dashboard diagram

Cloudflare's dashboard draws a diagram of a workflow by statically analysing the entrypoint's
`run()` for literal `step.do(...)` calls. A sagaflow workflow shows **no structure** there,
because its steps are called through a library rather than written literally in that function —
which is true of any library-mediated workflow, not a sagaflow quirk.

The runtime **instance** view is unaffected and shows every step by name as it happens,
including the engine's own: `finish-run`, `emit-events` and `compensate:*`.

Your own run records are the richer view anyway: they are rows, in your database, joinable
against the entities they touched, and they outlive the platform's retention window.

## Cancellation, precisely

`flow.cancel(runId)` raises a flag; the engine reads it back from the value `recordStep` already
returns and acts on it at the next step boundary. In a durable run that means: a run asleep in
`sleep()` or waiting in `waitForEvent()` does not notice until it wakes **and its next step has
finished**. That step runs, and is then undone with everything before it.

A waiting run's record says `running`, which is correct — and the abandoned sweep never touches a
durable run, so nothing takes it away underneath you.

`waitForEvent` has a default timeout of 24 hours; pass `timeout` to change it. A timeout throws,
which compensates the run.

## A known edge

If `WORKFLOWS.create` throws _after_ the instance actually exists — a lost response rather than a
refusal — sagaflow closes the run record as `failed`, and the instance that does exist may later
finish and try to flip it. The finish is conditional on the run still being `running`, so the
record stays `failed` and the two disagree about a run nobody was waiting for.

The fix, when it lands, is for `executeDurable` to verify the run is `running` before it starts.
Until then the symptom is a `failed` run whose steps all completed, which is at least visible.

## Testing on the real thing

`@cloudflare/vitest-pool-workers` runs real workerd with local D1, Queues and Workflows. Two
things to know:

- **Pin `wrangler` exactly** to the version the pool depends on. The pool embeds a specific
  wrangler and workerd; a caret bump silently splits your tests and your deploy onto two
  different runtimes.
- **A remote-only binding poisons the suite.** Declaring one (`ai`, for instance) makes the pool
  contact Cloudflare before a single test runs. Derive the test config from the real one with
  those stripped, so "the suite never touches the network" is a property of the runtime rather
  than a promise about the code.

The queue broker is not emulated: the pool gives you `createMessageBatch` and your handler
instead. The producer half is real — `dispatched_at` is only stamped once a real Queues binding
accepted the batch.
