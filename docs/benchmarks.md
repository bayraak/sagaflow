# Benchmarks

sagaflow asks you to make every write a saga. That is only a reasonable thing to ask if it is
cheap and if the promises hold, so here is the cost measured four ways: what it does to your
database, what it costs in time, how many of the guarantees break under fault injection, and how
much you have to write.

Reproduce with `bun run bench`. Method, and what is deliberately excluded, in
[`bench/README.md`](../bench/README.md).

## 1. What it costs your database

The part that is the same everywhere, because it is counted rather than timed. Every number here
is asserted in [`test/cost-model.test.ts`](../test/cost-model.test.ts), so a change to any of
them is a change somebody made on purpose.

|                                       | Cost                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Journal round trips, N-step run       | **N + 2** — one insert to open, one write per step, one to close             |
| …with a sink attached                 | **N + 3** — plus the note that the events were delivered                     |
| Statements in the closing batch       | **1 + one per event**, in **one** batch                                      |
| Statements to record a step           | **2**, in one batch — the write and the cancellation flag come back together |
| `sendBatch` calls for N events        | **ceil(N / 100)**                                                            |
| Steps re-executed on a re-invocation  | **0**                                                                        |
| Undo calls when a run fails at step k | **k − 1** — every completed step, never the failed one                       |

The write per step is a deliberate cost, not an oversight. Buffering the step trail would be
cheaper and would lose exactly the thing the trail is for: a run that died mid-flight still
leaves a readable partial record. One write to close a run is the other deliberate one — two
would make "completed, and its audit trail lost" a state this library could produce, and
[the property that says it cannot](../test/properties/outbox-atomicity.property.test.ts) rests
on it being one.

## 2. What it costs in time

Absolute numbers from one machine, with the machine attached. **There are no comparisons with
other libraries here and there will not be** — a number measured on this laptop against a number
somebody else measured on theirs is not a comparison.

```
Apple M1 Pro · arm64 · darwin 25.6.0 · bun 1.4.0 · sagaflow 0.1.0
642 ms of samples per subject, after 2000 warm-up runs, no sink
load average 3.62 5.85 5.89 while measuring
```

| Backing                     | Steps |       p50 |       p95 |       p99 |   Samples |
| --------------------------- | ----: | --------: | --------: | --------: | --------: |
| plain calls, no engine      |     1 |    125 ns |    125 ns |    333 ns | 4,757,481 |
| plain calls, no engine      |     5 |    209 ns |    291 ns |    458 ns | 2,659,398 |
| plain calls, no engine      |    20 |    542 ns |    750 ns |    916 ns | 1,050,355 |
| memory journal              |     1 |   1.71 µs |   2.33 µs |   4.96 µs |   323,493 |
| memory journal              |     5 |   4.92 µs |   7.62 µs |   9.46 µs |   116,469 |
| memory journal              |    20 |  16.88 µs |  22.04 µs |  28.04 µs |    33,984 |
| SQLite journal (`:memory:`) |     1 |  41.46 µs | 107.12 µs | 121.71 µs |    13,519 |
| SQLite journal (`:memory:`) |     5 |  94.04 µs | 160.12 µs | 179.33 µs |     6,030 |
| SQLite journal (`:memory:`) |    20 | 332.50 µs | 382.21 µs | 430.33 µs |     1,945 |

Split into the fixed cost of a run and the marginal cost of a step, from the slope between the
1-step and 20-step medians:

| Backing                     | Open and close a run |   Per step |
| --------------------------- | -------------------: | ---------: |
| plain calls, no engine      |               103 ns |      22 ns |
| memory journal              |           **911 ns** | **798 ns** |
| SQLite journal (`:memory:`) |             26.14 µs |   15.32 µs |

### Reading this honestly

**The engine costs about a microsecond to open and close a run, and about 800 nanoseconds per
step.** That is the memory-journal line, and it is the right number for "what does sagaflow
itself cost", because nothing is being stored. On a mutation that takes 5 ms — a couple of
queries and an HTTP call — a five-step saga adds roughly 5 µs, or one part in a thousand.

**The SQLite line is mostly SQLite.** 15.32 µs per step buys two SQL statements inside a
transaction, durably, in a file you can query. Whether that is cheap depends entirely on what
the step was doing; next to an HTTP call it is free, and next to nothing at all it is not.

Two caveats on that line, both worth stating rather than burying:

- It is `:memory:`, so there is no disk in it. A file-backed database with the default sync mode
  does an fsync per transaction, and that figure would describe your disk.
- The SQLite adapter prepares each statement as it uses it rather than keeping prepared
  statements around. Measured on this machine, preparing and running an insert costs 1.79 µs
  against 0.75 µs for one prepared once — so with four prepares per step (the transaction's
  `begin` and `commit` included), something like a quarter of the per-step SQLite cost is
  statement preparation that a future version can simply stop paying. The number above is what
  the adapter costs today, not a floor.

The p99 columns are wider than the p50s by about the amount garbage collection accounts for at
these scales. The SQLite 1-step p95 is the widest relative outlier in the table, and it is the
subject with the smallest amount of work per sample, so it is the one most exposed to a
collection landing inside a measurement.

## 3. What it costs to be wrong

The third measurement is not a time, it is a count: how many of the guarantees break when
things go wrong at every point they can. Four properties in
[`test/properties/`](../test/properties/) generate scenarios rather than enumerate them, and
each one fails on the first violation it finds.

| Property                                                                                   | What is generated                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Compensation completeness](../test/properties/compensation-completeness.property.test.ts) | Any number of steps, failing anywhere, any pattern of undos declared and undos refusing, run sequentially or concurrently through a relay that inverts completion order |
| [Outbox atomicity](../test/properties/outbox-atomicity.property.test.ts)                   | The journal giving out at a step record, the finish, the outbox write inside the finish, or the delivery note — with the sink allowed to refuse alongside it            |
| [Re-invocation idempotency](../test/properties/reinvocation-idempotency.property.test.ts)  | An isolate dying at any checkpoint boundary, steps the platform never recorded, and pointless re-invocations after the run has already finished                         |
| [At-least-once delivery](../test/properties/at-least-once-dedupe.property.test.ts)         | Refused batches, lost delivery notes, and a transport that hands the same batch over twice, across more than one tenant                                                 |

```
20,000 scenarios — 5,000 per property — 0 violations
SAGAFLOW_PROPERTY_RUNS=5000 bun run test:properties
```

Two hundred scenarios per property is what the default run does, on a fresh seed each time,
with the seed printed so a find is reproducible via `SAGAFLOW_PROPERTY_SEED`.

Each property also states the situations it exists to cover and fails if a run never reached
one of them — a generator that drifts into exercising a single branch stays green while asking
nothing, and that is the way a suite like this normally dies. And each is confirmed by mutation:
giving envelope ids a timestamp, taking the dedupe out of the journal's finish, marking events
dispatched before sending them, or closing a run before its events are queued each make the
corresponding property fail with the specific thing it dropped.

These four are one of the three kinds of evidence behind the guarantees, and the weakest on its
own: a generator explores a wide input space through a narrow set of schedules. The other two —
the theorems and the exhaustive TLA+ model that found five defects in this engine — are in
[`docs/guarantees.md`](./guarantees.md), which also cross-links each property from the guarantee
it stands under.

## 4. What you must write

The only comparison in this document that survives leaving this machine, because it is counted
by a line counter and is therefore identical everywhere.

One mutation — hold a seat, charge a card, send a confirmation, where the first two can be
undone and the third cannot — implemented three times. Each version delivers the **same six
guarantees**: a run record, a step trail, compensation in reverse on failure, a per-tenant
idempotency claim, a transactional outbox, and at-least-once delivery. All three are
type-checked. The sources are in
[`bench/what-you-must-write/`](../bench/what-you-must-write/README.md).

|                          | Lines of code | Including comments |
| ------------------------ | ------------: | -----------------: |
| **sagaflow**             |        **34** |                 43 |
| hand-rolled try/catch    |           130 |                166 |
| raw Cloudflare Workflows |           155 |                203 |

Raw Cloudflare Workflows is the longest of the three, which surprises people. Durability is not
the expensive part. The platform gives you a step that does not run twice and an instance that
survives a deploy, and then leaves you to write the run record, the compensation chain, the
idempotency claim and the outbox anyway — plus the caller that has to open the run row before
the instance exists, because an instance cannot open its own.

Three details in those files are worth reading rather than counting, because they are the ones
people get wrong and the line count does not show:

- **The undo must be built from what the step returned, never from a closure.** On a
  re-invocation the platform answers a completed step from its journal without running the body,
  so a closure taken inside the step no longer exists — and the undo that lived in it is gone,
  silently, for exactly the runs that most need undoing.
- **Each undo has to be its own step**, or a retry re-runs undos that already happened. A refund
  issued twice is worse than the failure that caused it.
- **Closing the run and queueing its event must be one batch.** Two is the ordinary way to end
  up with a completed mutation that nobody was ever told about.

None of the three counts includes the sweepers that close abandoned runs and carry undelivered
events, the conformance suite that says whether a journal is correct, or a second executor. Those
come with the 34 lines.

## Tracking

Results are committed per version under [`bench/results/`](../bench/results/), each with the
machine that produced it. A version-to-version comparison is only meaningful between files whose
`machine` blocks match.
