---
name: sagaflow
description: Working in a codebase that uses sagaflow — adding or changing a workflow, a step, a journal adapter, an event, or a Cloudflare entrypoint; debugging a run that compensated, an event that arrived twice, or a durable instance that replayed. Load before writing any mutation that touches more than one thing.
---

# sagaflow

An embedded saga engine. The point is that **every** mutation is a saga, not just the occasional
long-running job — which is only reasonable because it is cheap (five journal round trips for a
three-step inline run) and because the promises are checkable (six guarantees, each with a test).

Every mutation is a **run**: validated input, steps that each declare
their undo, one atomic finish that records the outcome and queues the run's events, delivery at
least once. One definition executes **inline** in the request or **durably** on a workflow
engine. Run records and the outbox are rows in the host application's own database.

## The whole API

```ts
// the verbs — valid only inside a saga body
import { step, all, sleep, waitForEvent, ctx, runId } from 'sagaflow-js'
// declaring and configuring
import { saga, sagaflow } from 'sagaflow-js'
// operating
import { sweepEventOutbox, sweepAbandonedRuns, SagaError, SagaCancelledError } from 'sagaflow-js'
// adapters
import { createMemoryJournal, createMemorySink, createInProcessSink } from 'sagaflow-js/memory'
import { createSqlJournal } from 'sagaflow-js/sql'
import { createD1Journal } from 'sagaflow-js/d1'
import { createSqliteJournal } from 'sagaflow-js/sqlite'
import { journalConformance } from 'sagaflow-js/testing'
import {
  createStepPrimitive,
  createWorkflowEntrypoint,
  sendWorkflowEvent,
} from 'sagaflow-js/cloudflare'
```

## Adding a saga, end to end

1. **Write the body.** `saga(name, body)` or `saga(name, options, body)`, where the body is
   `async (input) => value`. Inside it, `await step(name, run, undo?)` does the work. `undo`
   receives **exactly what the step returned** — one rule, no second channel. A reusable step is
   a plain function that calls `step()`; there is no separate constructor.

   **What belongs in a step:** effects, and anything you want in the record. A pure check over
   data you already hold can be plain code — if it throws, the run compensates and the error says
   why; wrap it in `step()` only when you want it named in the trail. Anything that touches the
   world (a query, a write, a provider) is a step.

2. **Choose the executor.** `durable: true` if it sleeps, waits, fans out, touches the outside
   world, takes more than roughly a second, or must survive a crash. Inline is the default and is
   what most mutations are.

3. **Declare what it needs.** `input` (any Standard Schema), `output`, `idempotent: true` or a
   function, and `announce`. All optional.

   **Events are derived from the run, not emitted by the body.** An effect declares what it
   announces beside how it is undone — `action(work, { undo, announce })`, or `announce` in a
   step's options. A run declares what its completion announces —
   `saga(name, { announce: (output, input) => ['booking.created', { id: output.id }] }, body)`,
   one event, an array of them, or `null`. A body announces nothing: a line in the middle of a
   body announces something that has not happened yet, because the run can still fail on the
   next line.

4. **Call it.** `await createBooking(input, flow)` runs it and answers with what the body
   returned. `.try(input, flow)` answers instead of throwing. `.start(input, flow)` hands a
   durable one to the configured launcher — and exists only on a durable definition.

5. **Configure once.** `sagaflow({ journal, events, eventSchemas, launcher, sagas, observer })`.
   `flow.for({ tenantId, actor, ...extras })` scopes a request; the extras reach every body
   through `ctx()`. The tenant comes from the session, **never** from input.

6. **Test it by calling it.** Memory journal, no platform, milliseconds.

```ts
const flow = sagaflow({ journal, events, sagas: [createBooking, chaseInvoice] })

await createBooking(input, flow.for({ tenantId, actor }))
```

## Verbs are awaited, reads are not

`step`, `all`, `sleep`, `waitForEvent` return promises — await every one. `ctx()` and
`runId()` are plain reads. A step started and not awaited fails the run by name. Turn on
`@typescript-eslint/no-floating-promises`.

## The rules the library keeps for you

- Compensation runs in reverse **start** order, every undo is attempted even after one refuses,
  and the run closes `compensated` only if all of them came back.
- The run closes and its events are written in **one atomic batch**.
- Envelope ids are `${runId}:${ordinal}` — deterministic, so a re-invoked body writes its events
  once.
- `finish-run` goes through the step runner, so a durable platform checkpoints it.
- An idempotency key is held by running and completed runs and released by the rest.
- Every step's own context carries `idempotencyKey` = `${runId}:${seq}` (`:undo` for an undo),
  stable across attempts and replays, plus `attempt`, `runId`, `tenantId`, `actor` and `ctx`.
- A step name reused within one run is refused, on both executors.
- `workflow.completed` and `workflow.compensated` belong to the engine; announcing one yourself
  is refused.
- A saga called inside another saga joins its trail under `child.name/step`; one run, one undo
  chain.

## The rules you still have to keep

- **Determinism outside steps.** A durable body re-runs from the top on every invocation; only
  step results are memoised. `Math.random()`, `Date.now()` and reads of mutable globals belong
  **inside** a step.
- **Step outputs are small.** Cloudflare caps a step's output at 1 MB. Return receipts, not
  entities; put the bytes in object storage.
- **Never reshape a deployed durable workflow.** Renaming or reordering steps breaks in-flight
  instances, which replay completed steps by name. Version by name (`invoice.send.v2`), let the
  old one drain, then retire it.
- **One name per use.** Fan-out needs a name per item — `step(`notify-${id}`, ...)` — otherwise
  the second use is handed the first one's memoised result and its work never happens. The engine
  refuses the duplicate, so this is a loud failure rather than a silent one.
- **One atomic write per step.** Cross-step consistency is the compensation chain, not a
  transaction spanning steps.

## Testing recipe

```ts
const journal = createMemoryJournal()
const sink = createMemorySink()
const flow = sagaflow({ journal: journal.journal, events: sink.sink })

await createBooking({ seat: '12A' }, flow)

// durable, no platform
const platform: StepPrimitive = {
  do: async (_name, _config, run) => run({ attempt: 1 }),
  sleep: async () => undefined,
  waitForEvent: async () => ({}) as never,
}
await executeDurable(definitionOf(chaseInvoice)!, { runId, input }, flow.runtime, platform)
```

If you write a journal adapter, prove it with `journalConformance` from `sagaflow-js/testing` —
the contract as executable cases, covering every promise the engine relies on, runnable under
any test runner.

Assert on the rows the journal holds, not on which functions were called. To reproduce a durable
replay, make `do` cache results by name; to reproduce retries, make it call `run` more than once
with rising `attempt`.

## Landmines

- **Re-invocation.** A durable instance can run the same body twice for one run. Everything
  after the body must be idempotent — it is, but only because envelope ids are deterministic and
  the finish is a checkpointed step. Do not move work out of a step into the body "for speed".
- **Fan-out under one name.** The second item would silently get the first item's result — the
  single most common durable bug. Refused at runtime now, but derive the name from the data and
  never from a loop counter over an unordered collection.
- **A step that announces and then throws.** The announcement is dropped with the run, on purpose. If
  something downstream must hear about a failure, that is what `workflow.compensated` is for.
- **`db.transaction()` on Cloudflare D1.** It type-checks and throws at runtime. A batch is the
  only atomic unit; that is why the journal contract asks for one.
- **Pinning the test runtime.** `@cloudflare/vitest-pool-workers` embeds a specific wrangler and
  workerd. Pin `wrangler` **exactly** to the version the pool depends on, or the runtime the
  suites prove things against is not the runtime a deploy targets.
- **A remote-only binding poisons the suite.** Declaring one makes the pool contact the provider
  before a single test runs. Strip those from the config the tests use.
- **`terminate({ rollback: true })` on a Cloudflare instance** runs Cloudflare's rollbacks, not
  sagaflow's compensations. Use `requestCancellation` so the run record stays honest.

## Diagnosing a run

| Symptom                             | Look at                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run stuck `running`                 | Inline? Its process died — `sweepAbandonedRuns` closes it. Durable? It may be sleeping or waiting; that is legitimate and the sweeper never touches it. |
| Run `failed`, not `compensated`     | An undo refused. The `compensate:*` step row carries the error.                                                                                         |
| Consumer saw an event twice         | Expected. Delivery is at-least-once; dedupe on the envelope id.                                                                                         |
| Consumer saw an event never         | Check `dispatched_at` on the outbox row and whether the sweeper is scheduled.                                                                           |
| Second call answered `deduplicated` | A run holds the key. It is released when the run fails, compensates or is cancelled.                                                                    |
| A fan-out did the work once         | One name for every item. Derive it from the data.                                                                                                       |
