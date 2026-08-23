# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with the usual pre-1.0 caveat: while
the major version is `0`, a minor bump may contain a breaking change and a patch never will.

## 0.1.2 — 2026-08-23

The first five minutes: two lines instead of six, and no `async` where nothing waits.

### Changed

- **The zero-configuration path says one thing, once, per instance.** Two pieces of code had each
  decided the not-durable warning was theirs to say, so a quickstart got both — a one-liner about
  the in-memory default and a four-line paragraph underneath it, the second one repeated for every
  instance including an explicit `sagaflow({})`. There is one now, and it says what is wrong, what
  it costs and what to type instead:
  `sagaflow: in-memory journal — state is lost when the process exits; pass a journal (sagaflow-js/sqlite or sagaflow-js/d1) before production.`
  It still goes through `warn`, and a configured journal still silences it.
- **The development logger folds a run's events into the run's own line.** It used to print each
  envelope and its payload underneath the trail, lifecycle events included, so a two-step run
  printed four times and the line that mattered scrolled away. One line now:
  `[sagaflow] booking.create · run_1 · completed 1ms · reserve ✓ charge ✓ · 2 events (booking.created, workflow.completed)`.
  The in-process sink still delivers and still marks delivered — so `flow.inspect` shows what a
  real deployment would show — and prints nothing. Payloads are for `flow.inspect` and
  `flow.explain`, where somebody went looking for them.

### Added

- **A step's work may be synchronous.** `run` and `undo` now take `MaybePromise<Output>` — the
  engine has always awaited whatever they hand back, and awaiting a plain value is what `await`
  is for. `step('check-totals', () => ({ data: check(input) }))` with no `Promise.resolve`, in
  every form: the ambient verb, `wf.step`, a reusable `defineStep`, an `action()` target and an
  `undo` that has nothing to wait for. Plenty of work is not asynchronous — totalling a basket,
  deriving a reference, checking an invariant — and it is recorded as a step to hang an undo on
  it, not because it waits for anybody. `MaybePromise` is exported for anybody writing the
  signatures out. Widening only; every existing `async` step is unaffected.

- **`onRunEnd` carries `events: string[]`** — the types the run queued in the batch that closed it,
  in order, never their payloads. Additive; an existing observer is unaffected.

## 0.1.1 — 2026-08-23

Published under the unscoped name **`sagaflow-js`**. The first release went out briefly under a
scope; the scoped package is unpublished and every import specifier here reads `sagaflow-js`,
with subpaths like `sagaflow-js/cloudflare`. The library, the repository and everything you type
in a body are still `sagaflow`.

A formal model of the run lifecycle was written and model-checked in this cycle. It found five
defects. All five are fixed below, each with a test that reproduces the counterexample against
the real engine and an ablation in `formal/` that removes the fix and watches the invariant fall
again. If you are running 0.1.0 durably, upgrade.

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

### Fixed — the five the model found

Every one of these needs a durable run, an unlucky crash window, and a re-invocation. None of
them can happen to an inline run, which lives inside one request and is never invoked twice.

- **A fully unwound run could close `completed`, with every one of its effects reversed.** The
  worst answer this engine could give, and no invariant in the study caught it before it was
  written down. A run unwinds, the instance dies before the write that would have recorded it,
  and the run row still says `running`. Every step is memoised, so the re-invocation reaches the
  end of the body without running anything fresh — and closes the run as a success. The caller is
  told the work succeeded and nothing it did is standing. A run that has begun unwinding may no
  longer finish.
- **A re-invoked body walked past the point at which the run was closed.** Cooperative
  cancellation is read from what `recordStep` returns, and a memoised step does not call
  `recordStep`. A replay therefore did not notice a cancellation the first invocation noticed,
  and ran steps for real against a run already recorded as fully undone. A durable invocation now
  reads the run once before it runs anything and stops if it has already ended.
- **A closed run could announce itself twice, under two different ids.** The lifecycle
  announcement was minted at the next ordinal of the walk, so a longer walk gave it a different
  id, and `on conflict do nothing` could not recognise the repeat. A closure is now identified by
  the run: `${runId}:completed`, `${runId}:compensated`, `${runId}:swept`,
  `${runId}:start-refused`. A run closes once, so its closure has one id, however far anybody
  walked. `lifecycleEnvelopeId` is exported for anybody reasoning about their own outbox.
- **A refused undo was retried by a later invocation, out of order.** A refusal is not
  checkpointed, so the next invocation tried it again — after the undos that came later in
  reverse order had already succeeded. The retry could then succeed and the run be written down
  `compensated`, which reads as "unwound in reverse start order" and was not. A recorded refusal
  is now final: the undo is not attempted again, the run closes `failed`, and the refused step is
  named in the error.
- **A run that had begun unwinding was carried forward into steps that never ran.** Same blind
  spot, with the run still open: the replay does not re-read the flag that started the unwind, so
  the body reached a fresh step and ran it, and its undo landed after an undo that started
  earlier had already succeeded. A trail holding any compensation now stops the body advancing.

- **The abandoned-run sweeper could displace an event a live run really emitted.** It minted its
  announcement at ordinal 0 — sound about a run that is dead, and unsound as an identity, because
  ordinal 0 is also the id of a run's own first emission. With the sweep window set shorter than
  a request, the conflicting insert silently dropped the run's first event, which no amount of
  re-delivery can repair.

### Fixed — the rest

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

### Evidence

- **`formal/`** — a TLA+ model of the run lifecycle, the transactional outbox and both sweepers,
  with eight TLC configurations. Two are the shipped design: every invariant holds, exhaustively,
  at three steps and three invocations and again at four and four. Six are ablations, each
  removing one thing the engine relies on — an optional journal read, deterministic envelope ids,
  a sweep window set correctly, deterministic replay of a failed step — so that every finding can
  be reproduced on demand. `formal/check.sh` compares all eight against what `formal/RESULTS.md`
  records and fails when a model stops behaving as recorded, including when one that is supposed
  to find a counterexample stops finding it.
- **`test/properties/`** — four generative properties: compensation completeness, outbox
  atomicity, re-invocation idempotency, at-least-once delivery with dedupe. Two hundred scenarios
  each by default, on a fresh printed seed, each one stating the situations it must reach and
  failing if a run never reached them.
- **`docs/guarantees.md`** — the six promises as theorems, the nine TLA+ invariants with their
  verdicts, the five findings with what closed each, and a section on what is not proven that is
  worth reading before the theorems.
- **`bench/` and `docs/benchmarks.md`** — engine overhead per run and per step against three
  journals, absolute numbers with the machine stated, and the same mutation implemented three
  times to count what you must write yourself.

### Note for journal authors

`getRun` and `listRunSteps` are still optional in the journal contract, and the durable executor
skips its entry reads when they are absent. A journal without `listRunSteps` gives up three of
the five fixes above; a journal without either gives up four. Every journal shipped here
implements both. If you have written your own, implement both.

## 0.1.0 — 2026-08-22

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
