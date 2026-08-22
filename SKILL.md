---
name: sagaflow
description: Working in a codebase that uses sagaflow — adding or changing a workflow, a step, a journal adapter, an event, or a Cloudflare entrypoint; debugging a run that compensated, an event that arrived twice, or a durable instance that replayed. Load before writing any mutation that touches more than one thing.
---

# sagaflow

An embedded saga engine. Every mutation is a **run**: validated input, steps that each declare
their undo, one atomic finish that records the outcome and queues the run's events, delivery at
least once. One definition executes **inline** in the request or **durably** on a workflow
engine. Run records and the outbox are rows in the host application's own database.

## The whole API

```ts
import {
  createStep,
  namedStep,
  defaultStepConfig,
  reservedStepNames,
  defineWorkflow,
  executeRun,
  executeDurable,
  startDurableWorkflow,
  instanceIdFor,
  registerDurableWorkflow,
  createDurableRegistry,
  dispatchEvents,
  sweepEventOutbox,
  sweepAbandonedRuns,
  requestCancellation,
  WorkflowCancelledError,
  WorkflowError,
  SchemaError,
  messageOf,
} from 'sagaflow'
import { createMemoryJournal, createMemorySink } from 'sagaflow/memory'
```

## Adding a workflow, end to end

1. **Write the steps.** `createStep(name, invoke, compensate?, config?)`. `invoke` returns
   `{ output, compensateWith? }`. The undo is registered **from the returned value**, never from
   a closure — a durable replay does not run the body again, and anything living in that closure
   is gone.
2. **Compose the definition.** `defineWorkflow({ name, input, execution, output?, idempotency? }, body)`.
   `input` and `output` are any Standard Schema (Zod, Valibot, ArkType). `idempotency` derives a
   key from the parsed input.
3. **Choose the executor.** Durable if it sleeps, waits, fans out, touches the outside world,
   takes more than roughly a second, or must survive a crash. Inline otherwise.
4. **Run it.** Inline: `definition.run({ input, ctx })`. Durable:
   `startDurableWorkflow(env, definition, { input, ctx })`, and register the definition in the
   dispatcher's registry — that registry is the only thing that makes it reachable by name.
5. **Emit what it announces.** `wf.emit(type, payload)` in the body, `ctx.emit(...)` in a step.
   Held until the run succeeds, written in the closing batch, delivered afterwards.
6. **Test it.** Memory journal, and a fake `StepPrimitive` for durable definitions. No platform.

```ts
const ctx = { tenantId, actor, journal, events, eventSchemas }
```

`tenantId` comes from the session, **never** from procedure input.

## The rules the library keeps for you

- Compensation runs in reverse **start** order, every undo is attempted even after one refuses,
  and the run closes `compensated` only if all of them came back.
- The run closes and its events are written in **one atomic batch**.
- Envelope ids are `${runId}:${ordinal}` — deterministic, so a re-invoked body writes its events
  once.
- `finish-run` goes through the step runner, so a durable platform checkpoints it.
- An idempotency key is held by running and completed runs and released by the rest.
- Every step context carries `ctx.idempotencyKey` = `${runId}:${seq}` (`:undo` for a
  compensation), stable across attempts and replays.

## The rules you still have to keep

- **Determinism outside steps.** A durable body re-runs from the top on every invocation; only
  step results are memoised. `Math.random()`, `Date.now()` and reads of mutable globals belong
  **inside** a step.
- **Step outputs are small.** Cloudflare caps a step's output at 1 MB. Return receipts, not
  entities; put the bytes in object storage.
- **Never reshape a deployed durable workflow.** Renaming or reordering steps breaks in-flight
  instances, which replay completed steps by name. Version by name (`invoice.send.v2`), let the
  old one drain, then retire it.
- **One name per use.** A step definition used twice in one run needs
  `namedStep(step, 'chunk-3')`; otherwise the second use is handed the first one's memoised
  result and its work never happens.
- **One atomic write per step.** Cross-step consistency is the compensation chain, not a
  transaction spanning steps.

## Testing recipe

```ts
const { journal, runs, steps, finishes, outbox, dispatched } = createMemoryJournal()
const { sink, sent, batches } = createMemorySink()

// inline
await definition.run({ input, ctx: { tenantId: 'acme', journal, events: sink } })

// durable, no platform
const platform: StepPrimitive = {
  do: async (_name, _config, run) => run({ attempt: 1 }),
  sleep: async () => undefined,
  waitForEvent: async () => ({}) as never,
}
await executeDurable(definition, { runId, input }, ctx, platform)
```

Assert on the rows the journal holds, not on which functions were called. To reproduce a durable
replay, make `do` cache results by name; to reproduce retries, make it call `run` more than once
with rising `attempt`.

## Landmines

- **Re-invocation.** A durable instance can run the same body twice for one run. Everything
  after the body must be idempotent — it is, but only because envelope ids are deterministic and
  the finish is a checkpointed step. Do not move work out of a step into the body "for speed".
- **Fan-out without `namedStep`.** The second item silently gets the first item's result. This is
  the single most common durable bug.
- **A step that emits and then throws.** The emission is dropped with the run, on purpose. If
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
| A fan-out did the work once         | Missing `namedStep`.                                                                                                                                    |
