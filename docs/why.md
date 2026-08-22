# Why sagaflow exists

The long form of the README's "The problem". If you only read one section, read
[the six guarantees](#exactly-what-is-guaranteed).

## The problem

A backend mutation rarely touches one thing.

"Save the invoice" is a row in `invoices`, an increment of a per-tenant counter, a PDF in object
storage, an email to the customer, and an event that three other parts of the system are waiting
for. Five effects, four of them outside the transaction you were imagining.

Four things then go wrong, and they go wrong in production rather than in review:

**The third write fails and the first two have happened.** The invoice row exists, the counter
has moved, and no PDF was ever written. Somebody has to notice, and then somebody has to write
the cleanup by hand — in the right order, handling the case where the cleanup itself fails.

**The request is retried and everything happens twice.** A double-click, a proxy timeout, a
client library with a retry policy, a cron that fired twice because the scheduler restarted. Two
invoices, two emails, one very unhappy customer.

**It succeeds and nobody can say what happened.** Three weeks later somebody asks why customer
4021 was invoiced twice on the 14th. The log line has rotated away. The row's `updated_at` says
when, not why, and certainly not by whom or in what order.

**The event is either a lie or a loss.** Send it before the commit and you have announced
something that may not have happened. Send it after and a crash between the two loses it — and
if the send throws, you have just told the caller that its committed work failed.

Databases solved all four of these _inside one store_, decades ago: transactions, a write-ahead
log, unique constraints, a replication log. The distributed write path of an application has no
equivalent. So teams either hand-roll try/catch cleanup — which is the correct instinct and the
wrong amount of work — or adopt a durable-execution platform for every write and pay instance
latency and a second system of record for a 5 ms update.

## What sagaflow is

**The transaction layer for the application write path.**

Every mutation becomes a **run**:

1. validated input
2. steps that each declare their own undo
3. one atomic finish that records the outcome **and** queues the run's events
4. delivery at least once, deduplicated by a deterministic id

The same definition executes **inline** inside the request — microseconds of overhead, no
instance, no platform — or **durably** on a workflow engine when it sleeps, waits, fans out,
calls the outside world, or must survive a crash.

The run record and the outbox are rows in your own database. Not a service's. Yours: query them,
join them against the entities they touched, back them up with everything else, put row-level
security on them, hand them to an agent.

The analogy is exact rather than decorative:

| A database has    | sagaflow has                         |
| ----------------- | ------------------------------------ |
| write-ahead log   | the run record and its step trail    |
| rollback          | compensation, in reverse start order |
| commit            | the `finish-run` batch               |
| replication log   | the outbox                           |
| unique constraint | the idempotency key                  |

## Exactly what is guaranteed

Six promises. Each one is a test in this repository, and the link goes to it.

### 1. A step's effect is at most one atomic write

Cross-step consistency is the compensation chain, not a transaction spanning steps — because on
the platforms this runs on, there is no such transaction to have. Undos run in **reverse start
order**, **every** one is attempted even after an earlier one refuses, and the result is written
down: `compensated` when the change was fully reversed, `failed` when something is still
standing.

Proved by [`engine.compensation`](../test/engine.compensation.test.ts),
[`engine.unwinding`](../test/engine.unwinding.test.ts),
[`parallel`](../test/parallel.test.ts).

### 2. A run is `completed` if and only if its events are durably queued

One atomic batch closes the run and writes its events. "Completed with its audit trail lost" is
not a representable state — inject a failure into the outbox write and the run stays `running`,
for somebody to finish.

Proved by [`outbox`](../test/outbox.test.ts),
[`journal-failure`](../test/journal-failure.test.ts), and the conformance case
`finishRun closes nothing when its events cannot be written`, which every journal adapter has to
answer.

### 3. Events are delivered at least once, under deterministic ids

An envelope's id is `${runId}:${ordinal}`, so a re-invoked durable body produces exactly the ids
it produced the first time. The second write lands on rows that already exist, and a consumer
that dedupes on the id sees each event once.

Proved by [`engine.replay`](../test/engine.replay.test.ts),
[`engine.reinvocation`](../test/engine.reinvocation.test.ts),
[`outbox.sweep`](../test/outbox.sweep.test.ts).

### 4. An idempotency key is held by living runs and released by dead ones

Held by `running` and `completed` runs; released by `failed`, `compensated` and `cancelled` ones.
Per tenant, always — an input can be the same string for every tenant, and a key that left the
tenant out would let the first tenant to ask claim the work for everybody. The same work asked
twice is answered once; work that fell over can be asked for again.

Proved by [`idempotency`](../test/idempotency.test.ts),
[`idempotency.released`](../test/idempotency.released.test.ts).

### 5. Every run ends in exactly one of four states

`completed | compensated | failed | cancelled`. Inline runs whose process died are swept to
`failed` and say why. Cancellation is cooperative, compensates, and closes `cancelled` — or
`failed`, if an undo refused. Every one of those endings announces itself exactly once,
including the two that are easy to forget: a swept run, and a run whose platform refused to start
it.

Proved by [`cancellation`](../test/cancellation.test.ts), [`sweep`](../test/sweep.test.ts),
[`lifecycle-completeness`](../test/lifecycle-completeness.test.ts).

### 6. Every step has a stable key for the outside world

`ctx.idempotencyKey` is the same on every attempt and every replay of that step, and different
for every other step in the run. Hand it to a provider's idempotency header and a retried step
stops being a second charge. Inputs and outputs are validated by _your_ schema library, through
Standard Schema.

Proved by [`step-idempotency-key`](../test/step-idempotency-key.test.ts),
[`schema`](../test/schema.test.ts), [`output-schema`](../test/output-schema.test.ts).

### And what it costs

Counted, not felt, in [`cost-model`](../test/cost-model.test.ts): five journal round trips for a
three-step inline run, six with a sink; one batch to close a run; one batch of two statements per
step record; one send per hundred events; nothing at all on a re-invocation. Those numbers are
the design, and changing one is a reviewed decision.

## What it is not

- **Not a durable-execution engine.** It rides one when you want durability.
- **Not a state machine library.** A run is a trivial linear machine and steps are a log, not a
  graph. The axis is transactions, not diagrams.
- **Not a job queue.** No scheduling, no fan-out control, no backpressure.
- **Not a platform.** There is no service to run and nothing to log into.
- **No isolation between concurrent sagas** beyond what your own steps enforce. Two runs touching
  the same row race exactly as two requests would. Use your database's constraints and locks; a
  saga is not a transaction and never claims to be.
- **No flow control** — no per-tenant concurrency limits, throttling or debouncing.

## Why not the neighbours

See [comparison.md](./comparison.md) for the long version. The short one:

- **The object of design.** sagaflow models _every mutation_; the platforms model _the occasional
  workflow_. The outbox, the tenant in every row and key, and the cheap inline path all fall out
  of that single choice.
- **Runtime posture.** A zero-dependency library inside your request, on any runtime, writing
  your tables through a conformance-tested journal — rather than a platform that runs the engine,
  a runtime bet, or a long-lived process.
- **Compensation is not the differentiator.** Cloudflare, Vercel's DevKit and Effect all have it.
  What differs here is how precisely it is specified, not that it exists.

And the honest answer to "why not just write it by hand": you can, and the first version takes an
afternoon. It is the sixth one — with the undo order right, the outbox atomic, the ids
deterministic, the keys released on failure, and the sweepers written — that takes the year.
