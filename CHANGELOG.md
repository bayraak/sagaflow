# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0 — unreleased

First release. The engine is extracted from a production backend where it has run every domain
mutation, and every gap found in reviewing it for extraction is closed here rather than shipped.

### Added

- **One engine, two executors.** `defineWorkflow` produces an inline definition that runs itself
  inside the request, or a durable one started with `startDurableWorkflow` and executed by a
  workflow platform. The ordering, the step trail, the compensation and the outbox are one
  implementation, proven once for both.
- **Compensation** registered from a step's returned value, run in reverse **start** order, with
  every undo attempted even after one refuses. A run that could not be fully reversed closes
  `failed`, not `compensated`.
- **A run record** — status, input, output, error, the full step and compensation trail, the run
  it replays, and the run it was started from.
- **A transactional outbox.** A run closes and its events are written in one atomic batch, so
  "completed with its audit trail lost" is not a representable state. Delivery is at-least-once,
  with a best-effort drain and `sweepEventOutbox` behind it.
- **Cooperative cancellation** — `requestCancellation` flips a flag the engine reads back from
  the value `recordStep` already returns, so noticing it costs no extra round trip.
- **`sweepAbandonedRuns`** for inline runs whose process died. Durable runs are never touched.
- **Standard Schema** validation for inputs and outputs, so Zod, Valibot and ArkType all work and
  none is a dependency.
- **Adapters**: `sagaflow/memory` ships, and the `RunJournal`, `EventSink` and `StepPrimitive`
  contracts are public so anything else can be written against them.
- **Zero runtime dependencies.**

### Fixed, relative to the engine this was extracted from

- **A re-invoked durable run wrote its events twice, under ids no consumer could recognise.**
  Envelope ids are now `${runId}:${ordinal}`, the finish goes through the step runner so a
  platform checkpoints it, and what a step emitted travels home inside its memoised result — so a
  replayed step still contributes what it announced.
- **A failed run held its idempotency key forever.** An invoice whose send fell over could never
  be sent again, and the caller asking a second time was told `deduplicated: true, status:
'failed'`. Keys are now held by running and completed runs and released by the rest.
- **An inline run whose process died stayed `running` for ever**, never compensated and never
  flagged. `sweepAbandonedRuns` closes it and says why.
- **A step retried after a provider had already accepted the work had no stable key.** Every step
  context now carries one.
- **`workflow.compensated` was declared and consumed but never emitted.** The engine now writes
  it into the failure path's closing batch.
- **The instance id was derived from the idempotency key**, which made the platform a second
  dedup authority beside the run record; the two disagreed the moment a run record was swept
  away. An instance is now named after the run, and the regex that guessed whether a launcher's
  refusal meant "already running" is gone.
- **Compensation order under concurrency was unspecified** and, when specified as completion
  order, was not stable across a durable re-invocation. It is reverse start order, and a test
  drives one body twice to prove the two unwindings are identical.
