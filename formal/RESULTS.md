# TLC results

Model: [`Sagaflow.tla`](./Sagaflow.tla). Checker: TLC 2.19 (tla2tools 1.7.4), OpenJDK 25,
breadth-first, 8 workers. Five of the six runs below finish in under two seconds; the deep one
takes about half a minute.

Reproduce with `./fetch-tools.sh && ./check.sh`.

## The six models

| Config                                             | What it is                                                | States (distinct) | Depth | Outcome                   |
| -------------------------------------------------- | --------------------------------------------------------- | ----------------: | ----: | ------------------------- |
| [`SagaflowProven.cfg`](./SagaflowProven.cfg)       | the invariants that hold, exhaustively                    |           277,616 |    36 | no error found            |
| [`SagaflowDeep.cfg`](./SagaflowDeep.cfg)           | the same, one step and one invocation deeper              |         5,641,051 |    55 | no error found            |
| [`SagaflowNoCancel.cfg`](./SagaflowNoCancel.cfg)   | the same, cancellation removed — confines finding F1      |            36,688 |    36 | no error found            |
| [`Sagaflow.cfg`](./Sagaflow.cfg)                   | every invariant this study states                         |             9,700 |    11 | refuted — findings F1, F2 |
| [`SagaflowRandomIds.cfg`](./SagaflowRandomIds.cfg) | ablation: envelope ids minted fresh per invocation        |             1,733 |    10 | refuted — as designed     |
| [`SagaflowLiveSweep.cfg`](./SagaflowLiveSweep.cfg) | ablation: the abandoned-run sweeper's window is too short |               445 |     6 | refuted — finding F3      |

The state counts for the refuted models are the states explored before the first counterexample,
not the size of the space; TLC stops at the first violation.

## Verdict by invariant

Checked one invariant at a time against the base constants (N = 3, up to three durable
invocations, one lost delivery mark), with and without cancellation.

| Invariant                        | Statement                                                  | Base      | No cancellation |
| -------------------------------- | ---------------------------------------------------------- | --------- | --------------- |
| `TypeOK`                         | every variable stays in its declared range                 | holds     | holds           |
| `I1_FinishExactlyOnce`           | exactly one terminal status, and only after a close        | **holds** | holds           |
| `NeverReopens` (action property) | a terminal status never changes again                      | **holds** | holds           |
| `I2_NoCompletedWithoutEvents`    | `completed` implies every envelope is in the outbox        | **holds** | holds           |
| `I3_ExactlyOnceEffect`           | no fact is ever acted on twice, however often delivered    | **holds** | holds           |
| `I3b_DeliveredOnceWhenDrained`   | once every row is marked, every fact has been acted on     | **holds** | holds           |
| `I4_CompensationCompleteness`    | compensated implies every completed step undone, once      | refuted   | holds           |
| `I4b_ReverseStartOrder`          | those undos ran in reverse start order                     | refuted   | refuted         |
| `I4c_CompleteAtClose`            | the same completeness claim, evaluated when the run closed | **holds** | holds           |
| `I4d_ReverseStartOrderAtClose`   | the same ordering claim, evaluated when the run closed     | refuted   | refuted         |
| `I5_ReinvocationIdempotency`     | the outbox never changes after the close                   | refuted   | holds           |
| `I6_KeyExclusivity`              | at most one run holds an idempotency key at a time         | **holds** | holds           |
| `I7_OneClosureAnnounced`         | one lifecycle envelope per run, agreeing with the record   | refuted   | holds           |
| `I8_NoEffectAfterClose`          | no step runs for real after the run has closed             | refuted   | holds           |

`I4c` is not a weakened `I4`. Both are checked and both are reported. `I4` says the property is
true at every instant; `I4c` says it was true of the run at the moment its outcome was written
down. The engine delivers the second and not the first, and the gap between them is finding F1.

## Finding F1 — a re-invoked body walks past the point at which the run was closed

**Refutes `I4`, `I5`, `I7`, `I8`. Confined to the cancellation path** (all four hold in
`SagaflowNoCancel.cfg`).

The shortest counterexample, from `Sagaflow.cfg`, N = 3, durable:

```
 1  initial            durable run, three steps
 2  RequestCancel      somebody asks the run to stop
 3  StepSucceeds       step 1 runs; recordStep returns cancellationRequested; unwind
 4  UndoSucceeds       step 1 is undone
 5  UnwindCompletes    outcome: cancelled
 6  FinishCommit       the batch commits: status = cancelled,
                       outbox = { runId:1 -> workflow.compensated }
 7  Crash              after the D1 batch, before Workflows checkpoints finish-run
 8  Reinvoke           the platform re-invokes the instance
 9  StepReplay         step 1 returns from the memo -- and a memoised step never calls
                       recordStep, so the cancellation flag is NOT read at this boundary
10  StepSucceeds       step 2 EXECUTES FOR REAL, on a run already recorded cancelled
11  UndoSucceeds       step 2 is undone
12  UnwindCompletes    outcome: cancelled again
13  FinishCommit       minted is now 2, so the announcement is runId:2 -- a DIFFERENT id.
                       The status guard blocks the status write; the outbox insert is
                       not guarded, so a SECOND workflow.compensated lands.
```

Final state: `status = "cancelled"`, `closes = 1`, and
`outbox = { runId:1 -> workflow.compensated, runId:2 -> workflow.compensated }`.

**Root cause.** Cooperative cancellation is read from what `recordStep` returns, and a memoised
step does not call `recordStep`. A replay therefore does not notice a cancellation that the first
invocation noticed, and walks further than the invocation that closed the run did. Two
consequences follow, and they are independent of each other:

1. **Steps run after the run has been closed** (`I8`). The engine has no guard at the top of the
   body that asks whether this run is already terminal.
2. **The lifecycle announcement's ordinal is a function of the walk, not of the run** (`I5`,
   `I7`). A longer walk mints it at a higher ordinal, which is a different envelope id, which the
   `on conflict (id) do nothing` insert cannot recognise as a repeat. A consumer sees the run
   announce itself twice.

Note that `I1` still holds throughout: the `and status = 'running'` guard on the finish does its
job, and the run record is never reopened. The record is protected. The world and the outbox are
not.

**Why the success path is safe.** When a body runs to the end, every step is memoised by the time
the finish runs, so a replay walks exactly the same steps and mints the announcement at exactly
the same ordinal. Same for a journalled step failure: the failure repeats and the walk is
identical. Only a cancellation makes the second walk longer than the first.

**Two fixes, either of which closes it.**

- Guard the body. On entry, `executeRun` reads the run record; if the status is terminal it stops
  without walking. One journal read per durable invocation, and none at all for inline runs, which
  cannot be re-invoked. This closes `I8`, `I5` and `I7` together, and it is the fix that matches
  what the guarantee actually promises.
- Derive the lifecycle ordinal from the run rather than from the walk — reserve an ordinal for the
  announcement. This closes `I5` and `I7`, and leaves `I8` standing.

## Finding F2 — a refused undo retried in a later invocation runs out of order

**Refutes `I4b`, `I4d`. Independent of cancellation** (present in `SagaflowNoCancel.cfg`).

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

**What is actually true, and what the documentation should say.** Reverse start order is the order
the undos are **attempted within one invocation**. It is not the order in which the successful
undos are observed to happen across a re-invocation. A run recorded `compensated` means every
completed step was reversed; it does not mean they were reversed in reverse start order if any
undo refused along the way.

**Fixes.** Either record on the run that an undo refused at some point, so a later invocation that
finds everything undone closes `failed` rather than `compensated`; or narrow the documented claim
to what the engine gives. The second is cheap and honest; the first is a behaviour change.

## Finding F3 — the abandoned-run sweeper collides with the run it is closing

**Ablation `SagaflowLiveSweep.cfg`.** This one is gated on a misconfiguration:
`sweepAbandonedRuns` is documented as needing `olderThanMs` "comfortably longer than your longest
inline request". The model removes that assumption to measure what the misconfiguration costs.

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

Final state: `status = "failed"`, and the outbox holds a `workflow.compensated` announcement, step
2's event, and a `workflow.completed` lifecycle — for one run. Step 1's event no longer exists
anywhere.

**Root cause.** `sweepAbandonedRuns` mints its announcement at ordinal 0 because "the run emitted
nothing — it never reached its finish". That reasoning is sound for a run that really is dead, and
unsound as an identity: ordinal 0 is also the id of the run's own first emission. Two different
closers reach for the same envelope id, and `on conflict do nothing` resolves it by throwing away
whichever arrives second.

**Fix.** Give the sweeper's announcement an id that cannot collide with a run's own emissions —
a distinct suffix (`${runId}:swept`) rather than an ordinal from the same sequence. That makes
the collision impossible instead of improbable, and costs nothing.

## Ablation — what deterministic envelope ids buy

`SagaflowRandomIds.cfg` sets `DeterministicIds = FALSE`, modelling what the engine did before gap
1 of plan 031 §3 was closed: an id minted fresh at each emission rather than `${runId}:${ordinal}`.

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
11  SweepOutbox        delivered; the consumer has never seen this id, so it acts AGAIN
```

Final state: `doubleApplied = TRUE`. Two rows, two ids, one fact, two effects. With
`DeterministicIds = TRUE` the same trace writes one row and the consumer acts once — which is
`I3` holding in the base model. The deterministic id is load-bearing, and this is the measurement
of it.

## What the model assumes

These are the places where the model takes something on trust. Each is a real assumption about the
platform or about the code, and a wrong one would invalidate the corresponding result.

- **A1. A step that returns to the body has been checkpointed.** Writing the result is what the
  platform's step primitive does before it returns. The window where an effect happened and the
  step reported failure anyway is modelled as a plain failure — it is a retry, and it is the window
  `ctx.idempotencyKey` exists for. The model therefore does not prove anything about
  effect-versus-record atomicity for calls to the outside world, and nothing in this document
  should be read as claiming it does.
- **A2. A journalled step failure repeats on replay** (`JournalledFailures = TRUE`). If a platform
  re-executes a failed step and it succeeds on the replay after compensations have already run,
  the compensation argument does not hold, and neither finding F1 nor F2 is the worst of it. This
  is the deterministic-replay assumption every durable engine makes; it is stated here because it
  is an assumption and not a theorem.
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

`SagaflowDeep.cfg` runs the proven set at four steps and four invocations: 5,641,051 distinct
states to depth 55, exhaustive, no error. The confinement model was run at the same bounds as a
check on finding F1 (change the two numbers in `SagaflowNoCancel.cfg`): 253,876 distinct states to
depth 55, also clean. Nothing appears at four that did not appear at three, which is what entitles
the three-step models to stand as the default.
