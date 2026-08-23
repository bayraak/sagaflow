# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the usual pre-1.0 caveat: while
the major version is `0`, a minor bump may contain a breaking change and a patch never will.

## Unreleased → 0.1.1

Everything below is on `main` and unreleased. The version is bumped at publish, not here.

### Added

- **Batched durable starts.** `startDurableWorkflows` and `saga.startAll(inputs, flow)` create
  instances through the platform's `createBatch` in batches of a hundred, falling back to one
  call each on a binding that cannot batch. A fan-out — one instance per tenant, per recipient,
  per chunk — was a hundred round trips against a rate limit counted per second. Every input is
  validated before any run record is opened, and a refused batch closes every run it opened with
  the announcement every other closed run gets.
- **A size guard for step outputs.** `sizeGuard()` warns about a step whose output is too large
  for a durable platform to checkpoint, by name and with a size, before the run that finally has
  a large enough import finds out in production. It is an observer, and the engine measures only
  when its `onStepOutput` hook exists, so a serialisation per step is paid for by the people who
  asked for it. The zero-configuration instance installs it.
- **`docs/cheatsheet.md`** — one screen: declaring, calling, the verbs and which to await,
  binding undos to effects, configuring, operating, journals, Cloudflare, the four outcomes,
  testing, and the short list of things never to do.
- **`docs/positioning.md`, `docs/integrations.md`, `docs/migrating-from-medusa.md` and
  `docs/launch/`** — where it sits, how it plugs into Hono, tRPC, Next.js, Express and Elysia,
  how to arrive from Medusa's workflow SDK, and what to say on the day.

### Fixed

- **The reference journal left `replayOf` undefined where a table stores `null`.** An assertion
  could pass against the in-memory adapter and fail against a real database, which is precisely
  backwards — the reference adapter is meant to be the strict one.
- **`flow.replay` would start a durable instance for an inline saga.** An inline run has no
  instance to replay, and creating one for a definition that was never durable is a stranger
  failure than being told no.

### Changed

- **One count of the conformance suite, and it cannot drift.** Three documents claimed three
  different numbers of cases; the suite has thirty-seven. The number now appears once, where
  somebody is deciding how much they are signing up for, and a test fails if it stops matching
  the suite.

### Still to merge before this ships

- Property-based tests for the four invariants (`test/properties/`).
- Benchmarks and `docs/benchmarks.md` — engine overhead per step and per run, absolute numbers
  only, methodology and machine stated.
- The formal model (`formal/`).

## 0.1.0 — unreleased

Published as **`sagaflow-js`** — the unscoped name is reserved by npm's similarity
rule. The library, the repository and everything you type in a body are still `sagaflow`.

First release. The engine is extracted from a production backend where it runs every domain
mutation, and every gap found while reviewing it for extraction is closed here rather than
shipped.

### The surface

```ts
import { saga, step, emit } from 'sagaflow-js'

const createBooking = saga('booking.create', async (input: { seat: string }) => {
  const seat = await step(
    'reserve',
    () => seats.reserve(input.seat),
    (reserved) => seats.release(reserved.id),
  )
  await step('charge', () => cards.charge(seat.price))
  await emit('booking.created', { seatId: seat.id })

  return seat
})

await createBooking({ seat: '12A' })
```

- **`saga(name, options?, body)`** returns a callable definition: `await def(input, flow?)` runs
  it, `def.try(...)` answers instead of throwing, `def.start(...)` hands a durable one to a
  launcher and exists only when `durable: true`.
- **Ambient verbs** — `step`, `emit`, `sleep`, `waitForEvent`, and the reads `ctx`, `runId`,
  `idempotencyKey`, `attempt` — valid inside a saga body and clear about it when they are not.
  A saga body is an async function; `if`, `for` and `await` are the control flow, and
  `Promise.all` is the parallel group.
- **`action(fn, { undo })`** binds an undo to an effect where the effect is defined. Inside a
  saga it is a step; outside one it is exactly the function it wraps.
- **`sagaflow(config?)`** is configured once and knows where run records and events go, which
  launcher starts durable sagas and which sagas exist. With nothing configured it runs in memory
  and says so once. `flow.for({ tenantId, actor, ...extras })` scopes a request.
- **Two executors, one definition.** Inline by default; `durable: true` when it sleeps, waits,
  fans out, touches the outside world or must survive a crash.

### What it guarantees

Six promises, each with the test that proves it — see the README, and `test/cost-model.test.ts`
for what they cost.

- One atomic write closes a run **and** queues its events; "completed with its audit trail lost"
  is unrepresentable.
- Undos run in reverse **start** order, every one is attempted, and the result is recorded as
  `compensated` or `failed`.
- Envelope ids are deterministic, so a re-invoked durable body writes its events once.
- Idempotency keys are held by living runs and released by dead ones, per tenant.
- Every run ends in exactly one of four states, and announces itself exactly once.
- Every step carries a stable key for the outside world.

### Adapters

`sagaflow-js/memory`, `sagaflow-js/sql` (with `sagaflow/d1` and `sagaflow-js/sqlite`),
`sagaflow-js/cloudflare`, and `sagaflow-js/testing` — whose `journalConformance` is the journal
contract as thirty-five executable cases that any adapter, in any test runner, can prove itself
against.

### Zero runtime dependencies

Validation is [Standard Schema](https://standardschema.dev), so Zod, Valibot and ArkType all work
and none is required. `@cloudflare/workers-types` is an optional peer used only for types.

### Fixed, relative to the engine this was extracted from

- **A re-invoked durable run wrote its events twice, under ids no consumer could recognise.**
  Envelope ids are now `${runId}:${ordinal}`, the finish goes through the step runner so a
  platform checkpoints it, and what a step emitted travels home inside its memoised result — so a
  replayed step still contributes what it announced.
- **A failed run held its idempotency key forever.** An invoice whose send fell over could never
  be sent again, and the caller asking a second time was told `deduplicated: true, status:
'failed'`. Keys are now held by running and completed runs and released by the rest.
- **An inline run whose process died stayed `running` for ever**, never undone and never flagged.
  `sweepAbandonedRuns` closes it and says why.
- **A step retried after a provider had already accepted the work had no stable key.** Every step
  context now carries one.
- **`workflow.compensated` was declared and consumed but never emitted.** It is now written into
  the failure path's closing batch — and into the two endings that used to close a run in silence:
  a run the sweeper closes, and a run whose platform refused to start it.
- **The instance id was derived from the idempotency key**, which made the platform a second dedup
  authority beside the run record; the two disagreed the moment a run record was swept away. An
  instance is now named after the run, and the regex that guessed whether a launcher's refusal
  meant "already running" is gone.
- **Compensation order under concurrency was unspecified**, and completion order — the obvious
  choice — is not stable across a durable re-invocation. It is reverse start order, proved by
  driving one body twice and requiring the two unwindings to be identical.
- **A step still running when another failed was orphaned.** `Promise.all` rejects on the first
  failure while the others are still going; the engine now settles every in-flight step before it
  unwinds, so no undo is registered with nobody left to run it.
- **A body that caught the cancellation kept going and completed the run.** No further step starts
  once a run has been told to stop, and the run closes `cancelled` regardless.
- **A run that had already been closed could be closed again**, re-taking an idempotency key
  somebody else now held — a uniqueness violation thrown from inside a step. Whoever closed the
  run first decides how it ended.
- **A step name reused in one run** would have been handed the first use's memoised result. Repeat
  uses are now numbered — `reserve`, `reserve#2` — in call order, which a replay arrives at the
  same way.
- **The published ESM had extensionless relative imports**, which Node's own loader and
  TypeScript's `node16` resolution both reject.
