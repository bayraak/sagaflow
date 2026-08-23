# TLC results

Model: [`Sagaflow.tla`](./Sagaflow.tla). Checker: TLC 2.19 (tla2tools 1.7.4), OpenJDK 25,
breadth-first, 8 workers. Every run below finishes in a few seconds; all eight together take
about fifteen.

Reproduce with `./fetch-tools.sh && ./check.sh`.

This study found five defects. All five are fixed, each with a test that reproduces the
counterexample against the real engine, and each with an ablation here that brings the defect
back by removing its fix.

## The eight models

| Config                                                       | What it is                                                               | States (distinct) | Depth | Outcome                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------: | ----: | ------------------------------ |
| [`Sagaflow.cfg`](./Sagaflow.cfg)                             | the shipped design, every invariant this study states                    |            29,904 |    22 | no error found                 |
| [`SagaflowDeep.cfg`](./SagaflowDeep.cfg)                     | the same, one step and one invocation deeper                             |            86,788 |    27 | no error found                 |
| [`SagaflowNoEntryGuard.cfg`](./SagaflowNoEntryGuard.cfg)     | ablation: a journal without `getRun`                                     |            73,944 |    31 | no error found — see below     |
| [`SagaflowFlakyReplay.cfg`](./SagaflowFlakyReplay.cfg)       | ablation: a platform that re-executes a failed step                      |            29,904 |    22 | no error found — discharges A2 |
| [`SagaflowNoJournalReads.cfg`](./SagaflowNoJournalReads.cfg) | ablation: a journal with neither optional read                           |             8,808 |    13 | refuted — F1, F2, F4, F5       |
| [`SagaflowNoTrail.cfg`](./SagaflowNoTrail.cfg)               | ablation: a journal without `listRunSteps`                               |            12,504 |    11 | refuted — F2, F4, F5           |
| [`SagaflowRandomIds.cfg`](./SagaflowRandomIds.cfg)           | ablation: envelope ids minted fresh per invocation                       |             1,887 |     9 | refuted — as designed          |
| [`SagaflowLiveSweep.cfg`](./SagaflowLiveSweep.cfg)           | ablation: the abandoned-run sweeper's window is shorter than the request |               428 |     5 | refuted — misconfiguration     |

The state counts for the refuted models are the states explored before the first counterexample,
not the size of the space; TLC stops at the first violation, and its depth column is the length of
the trace it printed.

## Verdict by invariant

Every invariant holds in the shipped design, at both bounds. The last column names the ablation
that brings it down, which is the honest way to say what each part of the engine is holding up.

| Invariant                        | Statement                                                  | Shipped   | Refuted by                                   |
| -------------------------------- | ---------------------------------------------------------- | --------- | -------------------------------------------- |
| `TypeOK`                         | every variable stays in its declared range                 | **holds** | nothing                                      |
| `I1_FinishExactlyOnce`           | exactly one terminal status, and only after a close        | **holds** | nothing                                      |
| `NeverReopens` (action property) | a terminal status never changes again                      | **holds** | nothing                                      |
| `I2_NoCompletedWithoutEvents`    | `completed` implies every envelope is in the outbox        | **holds** | nothing                                      |
| `I3_ExactlyOnceEffect`           | no fact is ever acted on twice, however often delivered    | **holds** | random ids                                   |
| `I3b_DeliveredOnceWhenDrained`   | once every row is marked, every fact has been acted on     | **holds** | nothing                                      |
| `I4_CompensationCompleteness`    | compensated implies every completed step undone, once      | **holds** | neither journal read                         |
| `I4b_ReverseStartOrder`          | those undos ran in reverse start order                     | **holds** | no trail                                     |
| `I4c_CompleteAtClose`            | the same completeness claim, evaluated when the run closed | **holds** | nothing                                      |
| `I4d_ReverseStartOrderAtClose`   | the same ordering claim, evaluated when the run closed     | **holds** | no trail                                     |
| `I5_ReinvocationIdempotency`     | the outbox never changes after the close                   | **holds** | neither journal read, random ids, live sweep |
| `I6_KeyExclusivity`              | at most one run holds an idempotency key at a time         | **holds** | nothing                                      |
| `I7_OneClosureAnnounced`         | one lifecycle envelope per run, agreeing with the record   | **holds** | neither journal read, live sweep             |
| `I8_NoEffectAfterClose`          | no step runs for real after the run has closed             | **holds** | neither journal read, live sweep             |
| `I9_CompletedUndidNothing`       | a run that closed `completed` undid nothing                | **holds** | no trail                                     |

`I4c` is not a weakened `I4`. Both are checked and both are reported. `I4` says the property is
true at every instant; `I4c` says it was true of the run at the moment its outcome was written
down. Both hold now. The gap between them was finding F1, and it is worth keeping both because a
future change that reopens the gap will move only one of them.

`I9` was added late, in the middle of re-checking the fixes for F1 to F3, because the model
reached a state that every existing invariant was content with and that is nevertheless the worst
state this engine could reach. See F5.

## Finding F1 — a re-invoked body walks past the point at which the run was closed

**Refuted `I4`, `I5`, `I7`, `I8`.** Reproduce with `SagaflowNoJournalReads.cfg`. Pinned by
`test/formal-f1.test.ts`.

```
 1  initial            durable run, three steps
 2  RequestCancel      somebody asks the run to stop
 3  StepSucceeds       step 1 runs; recordStep returns cancellationRequested; unwind
 4  UndoSucceeds       step 1 is undone
 5  UnwindCompletes    outcome: cancelled
 6  FinishCommit       the batch commits: status = cancelled, and the announcement is written
 7  Crash              after the D1 batch, before Workflows checkpoints finish-run
 8  Reinvoke           the platform re-invokes the instance
 9  StepReplay         step 1 returns from the memo -- and a memoised step never calls
                       recordStep, so the cancellation flag is NOT read at this boundary
10  StepSucceeds       step 2 EXECUTES FOR REAL, on a run already recorded cancelled
11  UndoSucceeds       step 2 is undone
12  UnwindCompletes    outcome: cancelled again
13  FinishCommit       the announcement was minted at a higher ordinal, so it has a DIFFERENT
                       id. The status guard blocks the status write; the outbox insert is not
                       guarded, so a SECOND workflow.compensated lands.
```

**Root cause.** Cooperative cancellation is read from what `recordStep` returns, and a memoised
step does not call `recordStep`. A replay therefore does not notice a cancellation that the first
invocation noticed, and walks further than the invocation that closed the run did. Two
consequences, independent of each other: steps run after the run has been closed (`I8`), and the
lifecycle announcement's id is a function of the walk rather than of the run (`I5`, `I7`).

`I1` held throughout: the `and status = 'running'` guard on the finish does its job and the run
record is never reopened. The record was protected. The world and the outbox were not.

**Fixed, both halves.** A durable invocation reads the run once before it runs anything and stops
if it has already ended — one read per durable invocation, none at all inline. And a lifecycle
announcement is identified by the run rather than by the walk: `${runId}:completed` and
`${runId}:compensated`. A run closes once, so its closure has one id, however far anybody walked.

A run whose record has been swept away is not a run that ended, and is still carried out: refusing
it would be inventing an outcome nobody wrote down.

## Finding F2 — a refused undo retried in a later invocation runs out of order

**Refuted `I4b`, `I4d`. Independent of cancellation.** Reproduce with `SagaflowNoTrail.cfg`.
Pinned by `test/formal-f2.test.ts`.

```
 1  initial            durable run, three steps
 2  StepSucceeds       step 1
 3  StepSucceeds       step 2
 4  StepFails          step 3 fails; unwind
 5  UndoRefuses        the undo of step 2 refuses -- so compensate:step2 is NOT checkpointed
 6  UndoSucceeds       the undo of step 1 runs anyway, as designed, and IS checkpointed
 7  Crash              before the finish
 8  Reinvoke
 9  StepReplay         step 1 from the memo
10  StepReplay         step 2 from the memo
11  StepRefails        step 3 fails again; unwind
12  UndoSucceeds       the undo of step 2 is attempted again and succeeds this time.
                       compensate:step1 is memoised and is skipped.
13  UnwindCompletes    nothing refused in THIS invocation, so the outcome is compensated
14  FinishCommit       status = compensated
```

Final state: `status = "compensated"`, `undoOrder = <<1, 2>>`. Step 1 started before step 2, and
step 1's undo ran before step 2's undo. That is forward start order, not reverse.

**Root cause.** Two rules that are each right on their own compose badly. "Every undo is
attempted even when an earlier one refuses" is deliberate — it stops a completed step being left
standing because its neighbour could not be reversed. "A refused compensation is not checkpointed
and is retried on replay" is also deliberate. Together they mean the retry of an early-in-reverse-
order undo can land after undos that already succeeded, and the run is nevertheless written down
as `compensated`, which reads as "unwound in reverse start order".

**Fixed.** A durable invocation reads the run's trail once at entry and treats a recorded refusal
as final: the undo is not attempted again, the run closes `failed`, and the refused step is named
in the error. `failed` is the honest word — something was left standing and somebody has to look
at it.

## Finding F3 — the abandoned-run sweeper collides with the run it is closing

**Ablation `SagaflowLiveSweep.cfg`,** gated on a misconfiguration: `sweepAbandonedRuns` is
documented as needing `olderThanMs` "comfortably longer than your longest inline request". The
model removes that assumption to measure what the misconfiguration costs. Pinned by
`test/formal-f3.test.ts`.

```
 1  initial            inline run, two steps
 2  StepSucceeds       step 1
 3  StepSucceeds       step 2
 4  BodyCompletes      the body returns; the finish is about to write
 5  SweepAbandoned     the sweeper decides the run is abandoned and closes it failed,
                       with its announcement at ordinal 0
 6  FinishCommit       the run's own finish arrives. The status guard blocks the status
                       write, correctly. The outbox insert is NOT guarded: ordinal 0
                       CONFLICTS with the sweeper's announcement and step 1's event is
                       silently dropped; ordinals 1 and 2 are written.
```

**Root cause.** `sweepAbandonedRuns` minted its announcement at ordinal 0 because "the run emitted
nothing — it never reached its finish". That reasoning is sound for a run that really is dead, and
unsound as an identity: ordinal 0 is also the id of the run's own first emission. Two different
closers reached for the same envelope id, and `on conflict do nothing` resolved it by throwing away
whichever arrived second. An event the run really emitted stopped existing anywhere, which no
amount of re-delivery can repair.

**Fixed.** The sweep's announcement is `${runId}:swept`, and a refused start's is
`${runId}:start-refused`. Neither can collide with an emission's ordinal, so the collision is
impossible rather than improbable, and it costs nothing.

**What the ablation still reports, and why that is right.** Closing a live run remains a
misconfiguration with a cost. The run's own finish still arrives afterwards and still writes its
rows, so the outbox grows after the close (`I5`), holds two closure announcements for one run
(`I7`), and the run's remaining steps ran after something else had closed it (`I8`). Nothing is
LOST any more, which was the part worth fixing; the rest is what "you closed a run that was still
going" means, and the window is a configuration value, not a code path.

## Finding F4 — a run re-invoked after it began unwinding is carried forward

**Refuted `I4b`, `I4d`.** Reproduce with `SagaflowNoTrail.cfg`. Pinned by `test/formal-f4.test.ts`.

This is the residual the model still reported after F1 and F2 were fixed, and it is the same
family as both: a re-invocation walking past the point at which the last one stopped. Here the run
was never closed, so the entry guard does not engage.

```
 1  initial            durable run, two steps
 2  RequestCancel
 3  StepSucceeds       step 1 runs; recordStep reports the cancellation; unwind
 4  UndoSucceeds       step 1 is undone, and compensate:step1 IS checkpointed
 5  Crash              before the finish. The run row still says running.
 6  Reinvoke           nothing refuses this invocation
 7  StepReplay         step 1 from the memo -- no recordStep, so no cancellation read
 8  StepSucceeds       step 2 EXECUTES FOR REAL, on a run that had already decided to go down
 9  StepSucceeds/...   the cancellation is noticed again at step 2's recordStep; unwind
10  UndoSucceeds       step 2 is undone; compensate:step1 is memoised and skipped
11  FinishCommit       status = cancelled, undoOrder = <<1, 2>>
```

**Root cause.** The same blind spot as F1 — a memoised step does not re-read the flag — but with
the run still open, so nothing stopped the body. The new step's undo lands after an undo that
started EARLIER had already succeeded, and reverse start order becomes a claim about one
invocation rather than about the run.

**Fixed.** The trail read that F2 added answers this too: a trail holding any compensation says
the run began going down. From there the body may replay what is already recorded completed, and
may do nothing else — no fresh step runs.

The resumed run closes `compensated` rather than `cancelled`. The invocation that decided to stop
never got its decision written down, and this one will not invent a reason nobody recorded. Both
statuses mean the same thing about the world: fully unwound, nothing standing.

## Finding F5 — a fully unwound run can close COMPLETED

**Refuted `I9`, which had to be written first.** Reproduce with `SagaflowNoTrail.cfg`. Pinned by
`test/formal-f5.test.ts`.

```
 1  initial            durable run, one step
 2  RequestCancel
 3  StepSucceeds       step 1 runs; recordStep reports the cancellation; unwind
 4  UndoSucceeds       step 1 is undone
 5  Crash              before the finish. The run row still says running.
 6  Reinvoke
 7  StepReplay         step 1 from the memo. There is no fresh step to stop at.
 8  BodyCompletes      the body reaches the end
 9  FinishCommit       status = COMPLETED, with every effect the run produced already reversed
```

Final state: `status = "completed"`, `undoDone = {1}`. The caller is told the work succeeded, and
nothing it did is standing.

**Why no invariant caught it.** `I4` and `I4c` are conditioned on the run ending `compensated` or
`cancelled`; this run ends `completed`, so they say nothing. `I2` is satisfied — the events are
there. `I7` sees exactly one closure announcement. `I8` sees no effect after the close, because
the close is the last thing that happens. Every invariant in the study was content with the worst
state the study ever produced, which is the argument for `I9`: a run that closed `completed` undid
nothing.

**Fixed.** Once the trail says the run began unwinding, the body may not finish either. It
unwinds again — every undo it re-registers is already memoised, so nothing runs twice — and the
run closes `compensated`.

## Ablation — what deterministic envelope ids buy

`SagaflowRandomIds.cfg` sets `DeterministicIds = FALSE`, modelling an id minted fresh at each
emission rather than a function of the run. The entry guard is off in that config as well,
deliberately: with it on, a durable invocation stops before it can write a second set of
envelopes, which would hide the id property behind the guard rather than measure it.

```
 1  initial            durable run
 2  StepFails          step 1 fails; unwind (nothing to undo)
 3  UnwindCompletes    outcome: compensated
 4  FinishCommit       announcement written with a first-invocation id
 5  SweepOutbox        delivered; the consumer acts on it
 6  Crash              before the finish is checkpointed
 7  Reinvoke
 8  StepRefails        the same failure
 9  UnwindCompletes    the same outcome
10  FinishCommit       the announcement is written AGAIN under a second-invocation id,
                       because the id is not a function of the run
```

The consumer has no way to recognise the second envelope and acts twice: `I3` and `I5` both fall.
With `DeterministicIds = TRUE` the same trace writes one row and the consumer acts once. The
deterministic id is load-bearing, and this is the measurement of it.

## Ablation — what the two optional journal reads buy

`getRun` and `listRunSteps` are both optional in the journal contract. A journal that offers
neither leaves the durable executor with nothing to read at entry, and
`SagaflowNoJournalReads.cfg` brings back every finding in this study at once: `I4`, `I4b`, `I4d`,
`I5`, `I7`, `I8` and `I9`.

Taken apart, the two are not equal. `SagaflowNoTrail.cfg` — a journal with `getRun` and without
`listRunSteps` — refutes `I4b`, `I4d` and `I9`: findings F2, F4 and F5 all come back.
`SagaflowNoEntryGuard.cfg` — a journal with `listRunSteps` and without `getRun` — is **clean at
these bounds**, and that is itself a result: once the trail is read, the trail carries every
invariant this study states, and the entry guard is defence in depth rather than the thing holding
them up.

The entry guard stays. It closes a window the trail cannot see: a run closed by something that
left no compensation behind — a refused start, an operator, a sweep — has no trail to read, and
only the run's own status says it has ended. The model does not reach that state because it models
one closer per run; the code does not get to make that assumption.

## What the model assumes

These are the places where the model takes something on trust. Each is a real assumption about the
platform or about the code, and a wrong one would invalidate the corresponding result.

- **A1. A step that returns to the body has been checkpointed.** Writing the result is what the
  platform's step primitive does before it returns. The window where an effect happened and the
  step reported failure anyway is modelled as a plain failure — it is a retry, and it is the window
  `ctx.idempotencyKey` exists for. The model therefore does not prove anything about
  effect-versus-record atomicity for calls to the outside world, and nothing in this document
  should be read as claiming it does.
- **A2. A journalled step failure repeats on replay — no longer assumed.** Cloudflare's
  documentation states that a completed `step.do()` is read back from its persisted result on a
  replay, and that a step reaching its retry limit ends the instance in an `Errored` state. It does
  not say what a re-invocation does with a step that exhausted its retries, so this study stopped
  assuming an answer and measured both. `SagaflowFlakyReplay.cfg` sets
  `JournalledFailures = FALSE`, letting a previously failed step run again and succeed, and is
  clean: once the trail is read at entry, a run that has begun unwinding is not carried forward
  into any step that is not already recorded completed — including the one that failed — so the
  platform's answer stops mattering. Before the F4 fix it mattered a great deal.
- **A3. The output schema's verdict is a property of the run.** With every step memoised a
  re-invocation returns the same value and gets the same verdict, so the verdict is fixed at `Init`
  rather than redecided per invocation. An earlier version of this model let it differ and produced
  a counterexample that cannot happen; it is recorded here because the correction is the kind of
  thing a reader should be able to check.
- **A4. One run.** Concurrency between sagas is not modelled. A second claimant on the idempotency
  key is modelled abstractly, which is enough for `I6` and nothing more. Two runs racing on the
  same row race exactly as two requests would — that is a documented non-goal, not a gap in this
  model.
- **A5. Batching is abstracted.** Delivery is per envelope. The hundred-per-`sendBatch` limit is a
  cost, not a correctness property, and it is asserted exactly in `test/cost-model.test.ts`.
- **A6. Time is abstracted.** The outbox sweeper's grace window and the abandoned-run sweeper's
  window are not modelled as durations. The sweepers may fire whenever their guard allows, which is
  the worst case for a correctly configured window and, in `SagaflowLiveSweep.cfg`, for an
  incorrectly configured one.

## Bounds

The default models are `N = 3` steps, at most 3 durable invocations, at most 1 lost delivery mark,
one run, one idempotency key, one consumer. Every interesting ordering — a crash between the finish
batch and the finish checkpoint, a replay that reaches a step the first walk did not, a refused
undo retried after a successful one, a redelivery of an already-consumed envelope — appears within
three steps and two invocations, and each of the counterexamples above is at most fourteen states
long.

`SagaflowDeep.cfg` runs the shipped design at four steps and four invocations: 86,788 distinct
states to depth 27, exhaustive, no error. Nothing appears at four that did not appear at three,
which is what entitles the three-step models to stand as the default.
