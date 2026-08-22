# Guarantees

The README states six promises and links a test to each. This page is the same six stated as
theorems: what each one assumes, what exactly it claims, why the code delivers it, and what
evidence there is. It also states, in the same voice, the things that are **not** proven — because
a guarantee document that only lists guarantees is a marketing page.

Three kinds of evidence appear here.

| Evidence       | What it is                                                                                                    | Where                                |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Example tests  | one arrangement, one assertion. Proves the path exists and works.                                             | `test/*.test.ts`                     |
| Property tests | hundreds of arrangements from a generator, one invariant. Proves the path works for inputs nobody thought of. | `test/properties/*.property.test.ts` |
| Model checking | every interleaving of a bounded model, exhaustively. Proves there is no ordering that breaks it.              | [`formal/`](../formal/README.md)     |

They answer different questions and none of them replaces another. A test says "this happened once".
A property says "this holds across the input space we can generate". TLC says "there is no schedule
in this model that reaches a bad state". Where the three disagree, the disagreement is the finding,
and this page records three of those.

---

## Theorem 1 — a step's effect is one write, and the chain is the consistency

**Hypothesis.** Each step's journal effect is at most one atomic batch. Compensations are declared
per step and registered from the step's returned value.

**Statement.** Cross-step consistency is not a transaction; it is the compensation chain. When a
run fails, the undos are attempted in **reverse start order**, **every** undo is attempted even if
an earlier one refuses, and the outcome is recorded as `compensated` (nothing left standing) or
`failed` (something is).

**Proof sketch.** `executeRun` keeps `undos` in call order with each step's `seq`, and
`compensate` walks `undos.toSorted((l, r) => r.seq - l.seq)` — descending `seq`, which is start
order reversed. Start order rather than completion order because completion order is not stable
across a durable re-invocation: a replayed step returns from the journal instantly, so a body
under `Promise.all` completes in call order the second time and in real time the first, and the
same body would unwind two different ways. Before the first undo runs, `compensate` awaits
`Promise.allSettled` over every in-flight step, so no step can finish after unwinding began and
register an undo with nobody left to run it. Each undo is wrapped in its own `try`/`catch`: a
refusal sets the outcome to `failed` and the loop continues to the next one.

**Evidence.** `test/engine.compensation.test.ts`, `test/engine.unwinding.test.ts`,
`test/parallel.test.ts`, `test/engine.compensation-failure.test.ts`, `test/engine.inflight.test.ts`;
property `test/properties/compensation-completeness.property.test.ts`; TLA+ `I4c_CompleteAtClose`
(holds, exhaustive to four steps and four invocations).

**Caveat, proven.** The _completeness_ half is sound: a run recorded `compensated` has had every
completed step undone. The _ordering_ half is narrower than it reads. See finding F2 below.

---

## Theorem 2 — completed if and only if the events are queued

**Hypothesis.** The journal's `finishRun` is one atomic write. The reference SQL adapter issues the
status update and every outbox insert in a single `driver.batch`.

**Statement.** A run is `completed` if and only if its events are durably queued. "Completed with
its audit trail lost" is not a representable state.

**Proof sketch.** The engine mints `workflow.completed`, then calls `journal.finishRun` once with
`{ status: 'completed', output, events: held }`. There is no other path to a `completed` status and
no other path that writes a completed run's envelopes. `src/sql/index.ts` sends the update and the
inserts as one batch; the memory journal refuses the whole call if the outbox write would fail,
which is what a store with one atomic write does. The outbox inserts carry
`on conflict (id) do nothing`, so repeating the call with the same arguments is a no-op — which is
the case a durable re-invocation actually produces.

**Evidence.** `test/outbox.test.ts`, `test/journal-failure.test.ts`,
`test/lifecycle-completeness.test.ts`; property `test/properties/outbox-atomicity.property.test.ts`;
TLA+ `I2_NoCompletedWithoutEvents` (holds).

The model checks the strong form: across every interleaving of crash, replay, drain and sweep,
there is no reachable state in which `status = "completed"` and any of the run's envelopes is
missing from the outbox.

---

## Theorem 3 — at-least-once delivery with a deterministic identity

**Hypothesis.** Consumers deduplicate on the envelope id.

**Statement.** Every envelope is delivered at least once and carries an id that is a function of
the run — `${runId}:${ordinal}` — so a consumer sees each one once. A re-invoked durable body
writes its events **once**.

**Proof sketch.** Three things make the identity hold. Ids come from `src/identity.ts`, computed
from the run id and an ordinal counter, never from a clock or a random source. Events emitted
inside a step travel home in that step's memoised result (`{ output, events }`) and are minted by
the engine after the runner returns, so a replayed step still contributes its events and still
contributes them at the same ordinal. And `finishRun` goes through the step runner as the reserved
step `finish-run`, so a platform that has already checkpointed it does not run it again. Delivery
is `dispatchEvents`, shared by the run's own drain and by `sweepEventOutbox`: send a batch, then
mark it. A mark that is lost means the batch is sent again, which is the safe direction.

**Evidence.** `test/engine.replay.test.ts`, `test/engine.reinvocation.test.ts`,
`test/outbox.sweep.test.ts`, `test/events.test.ts`; property
`test/properties/at-least-once-dedupe.property.test.ts` and
`test/properties/reinvocation-idempotency.property.test.ts`; TLA+ `I3_ExactlyOnceEffect` and
`I3b_DeliveredOnceWhenDrained` (both hold).

The model earns this one rather than assuming it. `formal/SagaflowRandomIds.cfg` mints a fresh id
per invocation instead — what the engine did before this gap was closed — and TLC refutes
`I3_ExactlyOnceEffect` in eleven states: two rows, two ids, one fact, two effects. The
deterministic id is load-bearing, and that is the measurement of it.

**Caveat, proven.** There is one case where a re-invoked body writes a _second_ lifecycle envelope
under a different id. See finding F1 below.

---

## Theorem 4 — a key is held by the living and released by the dead

**Hypothesis.** The runs table carries a unique index on `(tenant_id, idempotency_key)` that is
**partial** — `where status in ('running', 'completed')`.

**Statement.** An idempotency key is held by `running` and `completed` runs and released by
`failed`, `compensated` and `cancelled` ones, per tenant. The same work asked twice is answered
once; work that fell over can be asked for again.

**Proof sketch.** `insertRun` throws when the key is held, and the throw _is_ the dedup signal;
`claimRun` answers it by looking up the holder rather than doing the work twice. The lookup is
`findRunByIdempotencyKey`, which is specified to answer for held runs only, by the same rule the
index refuses by. `claimRun` retries the insert exactly once when the journal names its refusal
`IdempotencyKeyHeldError` and the holder has since gone — a real race, and one where asking again
is right exactly once. The `and status = 'running'` guard on `finishRun` is the other half: a run
the sweeper already closed has released its key and somebody else may hold it, so a late finish
must not re-enter the held set.

**Evidence.** `test/idempotency.test.ts`, `test/idempotency.released.test.ts`, `test/start.test.ts`,
the journal conformance suite; TLA+ `I6_KeyExclusivity` (holds).

`I6` is the model's statement of the guard's purpose: at most one run holds a key at any instant.
It is checked against interleavings in which the sweeper closes a run, a second claimant is
admitted, and the first run's finish arrives afterwards — precisely the sequence that would
otherwise put two holders on one key.

---

## Theorem 5 — every run ends, exactly once, in one of four ways

**Hypothesis.** Inline runs live inside one request. Durable runs may legitimately sleep.

**Statement.** Every run ends in exactly one of `completed | compensated | failed | cancelled`, and
never reopens. Inline runs that die mid-request are swept to `failed`. Cancellation is cooperative:
it takes effect at the next step boundary and compensates.

**Proof sketch.** There are exactly two closers. The engine's `finishRun`, on the success path and
on the failure path, and `sweepAbandonedRuns`, which lists inline runs still `running` from before
a cutoff and closes each one through the same `finishRun`. Both are guarded on the run still being
`running`, so whichever arrives first decides how the run ended and the other is a no-op on the
status. Cancellation is a flag on the run row, read back from what `recordStep` returns, so
noticing it costs no round trip; the engine throws `SagaCancelledError` at the boundary, unwinds,
and closes `cancelled` if everything came back and `failed` if an undo refused. Durable runs are
never swept at any age: one may be asleep for a week, and failing it because it is old would be
the sweep inventing an incident rather than reporting one.

**Evidence.** `test/cancellation.test.ts`, `test/cancellation.swallowed.test.ts`,
`test/sweep.test.ts`, `test/lifecycle-completeness.test.ts`; TLA+ `I1_FinishExactlyOnce` and the
action property `NeverReopens` (both hold).

`I1` and `NeverReopens` are checked across every interleaving of crash, re-invocation, double
finish and sweep. They hold. The run record is the part of this system the model is most confident
about.

**Known limit, not a defect.** A durable run whose platform stops re-invoking it stays `running`
for ever. The abandoned-run sweeper deliberately does not touch durable runs, and there is nothing
else that would. The statement above is a safety property — no run ends twice — and not a liveness
one — every run ends.

---

## Theorem 6 — a stable key outward, your own schema inward

**Hypothesis.** The outside world offers idempotency on a key you supply.

**Statement.** Every step context carries `idempotencyKey = ${runId}:${seq}`, stable across
attempts and across replays; a compensation carries `${runId}:${seq}:undo`, because undoing a
charge is a refund and a different side effect deserves a different key. Inputs and outputs are
validated by whatever Standard Schema library you already use.

**Proof sketch.** Both keys come from `src/identity.ts` and are derived from the run and the step's
`seq`, which is assigned in call order and is therefore the same on a replay. `seq` is per call,
so a `namedStep` fan-out gets one key per item. Validation is `src/schema.ts`, which speaks the
Standard Schema interface and nothing else; an output the schema refuses sends the run down the
unwinding path rather than recording it `completed` with a value nobody can use.

**Evidence.** `test/step-idempotency-key.test.ts`, `test/schema.test.ts`,
`test/output-schema.test.ts`, `test/named-step.test.ts`, `test/step-context.test.ts`.

Not model-checked. This is a claim about the value of a field, which a test settles completely; an
interleaving cannot make `${runId}:${seq}` come out differently.

---

## The four properties

Stated precisely, so that the generator has something to falsify.

| Property                                                                                     | Statement                                                                                                                         |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`compensation-completeness`](../test/properties/compensation-completeness.property.test.ts) | For a run of n steps failing at any step k, every step that completed has its undo run exactly once, in reverse start order.      |
| [`outbox-atomicity`](../test/properties/outbox-atomicity.property.test.ts)                   | With a failure injected at any journal or sink boundary, no reachable state has a `completed` run whose events are not queued.    |
| [`reinvocation-idempotency`](../test/properties/reinvocation-idempotency.property.test.ts)   | Driving one durable body through a caching primitive N times yields exactly one set of outbox rows, with identical ids.           |
| [`at-least-once-dedupe`](../test/properties/at-least-once-dedupe.property.test.ts)           | Under random duplicate deliveries in random order, a consumer that dedupes on the envelope id acts on each envelope exactly once. |

These four and the TLA+ invariants overlap on purpose, and the overlap is the point: the properties
run against the real engine with a generated input space, the model runs against every ordering of
a simplified engine. A bug that is only reachable through a particular schedule hides from the
first; a bug in code the model abstracts away hides from the second.

---

## The TLA+ invariants

Full statements, verdicts, counterexamples and bounds are in [`formal/RESULTS.md`](../formal/RESULTS.md).
Summary:

| Invariant                      | Claim                                                    | Verdict                  |
| ------------------------------ | -------------------------------------------------------- | ------------------------ |
| `I1_FinishExactlyOnce`         | exactly one terminal status, only after a close          | holds                    |
| `NeverReopens`                 | a terminal status never changes again                    | holds                    |
| `I2_NoCompletedWithoutEvents`  | `completed` implies every envelope is queued             | holds                    |
| `I3_ExactlyOnceEffect`         | no fact is acted on twice, however often delivered       | holds                    |
| `I3b_DeliveredOnceWhenDrained` | once everything is marked, every fact has been acted on  | holds                    |
| `I4_CompensationCompleteness`  | compensated implies every completed step undone, once    | **refuted** — finding F1 |
| `I4b_ReverseStartOrder`        | those undos ran in reverse start order                   | **refuted** — finding F2 |
| `I4c_CompleteAtClose`          | the completeness claim, evaluated when the run closed    | holds                    |
| `I4d_ReverseStartOrderAtClose` | the ordering claim, evaluated when the run closed        | **refuted** — finding F2 |
| `I5_ReinvocationIdempotency`   | the outbox never changes after the close                 | **refuted** — finding F1 |
| `I6_KeyExclusivity`            | at most one run holds a key at a time                    | holds                    |
| `I7_OneClosureAnnounced`       | one lifecycle envelope per run, agreeing with the record | **refuted** — finding F1 |
| `I8_NoEffectAfterClose`        | no step runs for real after the run has closed           | **refuted** — finding F1 |

Bounds: three steps, three durable invocations, one lost delivery mark; 277,616 distinct states,
exhaustive. Re-run at four steps and four invocations — 5,641,051 states, depth 55 — nothing new
appears.

---

## Soundness, in the workflow-net sense

Van der Aalst's soundness criterion for a workflow net asks three things of a procedure: from every
reachable state it is still possible to reach the end state (**option to complete**); when the end
state is reached there is nothing else left in flight (**proper completion**); and no transition is
dead.<sup>[1]</sup>

A sagaflow run is a trivial workflow net — a linear sequence of steps with one entry and one exit —
and the mapping is worth stating because the triviality of the net is exactly why the interesting
questions are elsewhere.

| Soundness condition     | In sagaflow                                                                                                                                                     | Status                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Option to complete**  | From any point in the body, the run can reach a terminal status: forward through the remaining steps, or backward through the compensation chain to the finish. | By construction. The body is straight-line code; there is no branch that reaches neither the success finish nor the failure finish.          |
| **Proper completion**   | When a run reaches a terminal status, nothing of it is still running.                                                                                           | Enforced. `compensate` awaits `Promise.allSettled` over in-flight steps before unwinding, and the success path throws on any unawaited step. |
| **No dead transitions** | Every step in a body is reachable.                                                                                                                              | Not a property of the engine. A body with unreachable code is the author's business, as it is in any programming language.                   |

Two honest notes. Proper completion is enforced _within an invocation_: the model shows a durable
re-invocation walking a body whose run has already terminated, which is a violation of proper
completion across invocations rather than within one. That is finding F1. And a WF-net's soundness
says nothing at all about the outbox or the idempotency key, which is why the theorems above exist
and why the TLA+ model was worth writing: the interesting failures in this system are not in the
control flow, they are at the boundary between the control flow and a database.

The control-flow pattern coverage — which of van der Aalst and ter Hofstede's forty-three patterns
a straight-line-code workflow inherits and which it misses — belongs in `docs/theory.md` and is not
repeated here.

---

## What is NOT proven

Read this section as carefully as the theorems.

### Confirmed defects, found by the model

**F1 — a re-invoked durable body can walk past the point at which the run was closed.** If a
cancellation is noticed, the run is closed `cancelled`, and the instance then crashes in the window
between the finish batch committing and the platform checkpointing the `finish-run` step, the
re-invocation replays the memoised steps — and a memoised step does not call `recordStep`, so it
does not re-read the cancellation flag. The body therefore continues past where it stopped the
first time: **steps that never ran now execute for real, against a run already recorded as fully
undone**, and the second finish mints its lifecycle announcement at a higher ordinal, which is a
different envelope id, so a **second `workflow.compensated` lands in the outbox**. The run record
itself is safe — the `and status = 'running'` guard holds throughout, and `I1` is never violated.
Confined to the cancellation path: with cancellation removed, every affected invariant holds.
Full trace and the two candidate fixes in [`formal/RESULTS.md`](../formal/RESULTS.md#finding-f1--a-re-invoked-body-walks-past-the-point-at-which-the-run-was-closed).

**F2 — reverse start order is the order undos are _attempted_, not the order they _succeed_.** The
engine attempts every undo even when an earlier one refuses; a refused compensation is not
checkpointed, so a re-invocation retries it — after the undos that already succeeded. A run can
therefore be recorded `compensated`, meaning every completed step was reversed, while the reversals
happened in forward order. Independent of cancellation. Until this is closed, read
guarantee 1's ordering clause as: _within one invocation, undos are attempted in reverse start
order; if one refuses and the instance is re-invoked, the retry runs after its neighbours._
Full trace in [`formal/RESULTS.md`](../formal/RESULTS.md#finding-f2--a-refused-undo-retried-in-a-later-invocation-runs-out-of-order).

**F3 — the abandoned-run sweeper's announcement can collide with the run's own first event.**
`sweepAbandonedRuns` mints its announcement at ordinal 0, which is also the id of a run's first
emission. If the sweeper's window is shorter than the request — which the documentation warns
against, and which is therefore a misconfiguration rather than an inherent flaw — a live inline run
can be closed by the sweeper and then have its own finish arrive: the conflicting insert silently
drops the run's first event, and the outbox ends up holding a `compensated` announcement and a
`completed` lifecycle for the same run. Full trace in
[`formal/RESULTS.md`](../formal/RESULTS.md#finding-f3--the-abandoned-run-sweeper-collides-with-the-run-it-is-closing).

### Stated non-goals, unchanged

**No isolation between concurrent sagas.** Two runs touching the same row race exactly as two
requests would. The model checks one run; concurrency between sagas is not modelled and is not
claimed. Use your database's constraints and locks; the countermeasures — semantic lock, commutative
updates, pessimistic view, reread value, version file, by value — are documented patterns here, not
features.

**Cancellation is cooperative, and its latency is unbounded in principle.** A step already running
is never interrupted; the request is noticed at the next step boundary. A step that takes ten
minutes delays the cancellation by ten minutes. And, per F1, a boundary that replays from a memo is
not a boundary at which the flag is read at all.

**An external effect and the record of it are not atomic.** The model assumes that a step which
returns to the body has been checkpointed. It says nothing about the window between calling
somebody else's API and recording that you called it: a step can charge a card and then fail to
write that it did, and the retry will present the same `ctx.idempotencyKey` and rely on the
provider to recognise it. That is the best any library can do without a two-phase commit the
outside world has not agreed to, and `ctx.idempotencyKey` exists precisely because it cannot be
solved here.

**There is no exactly-once delivery.** There is an identity on every message and an outbox that
never loses one. Exactly-once _effect_ follows from the consumer deduplicating on that identity —
which is the consumer's obligation, stated in `I3` as a hypothesis and not proven of code that does
not live in this repository.

**A durable run whose platform gives up stays `running`.** See theorem 5.

**Determinism of the body is the author's obligation.** The engine numbers repeated step names in
call order and refuses reserved names, but a body that branches on `Math.random()` or the wall
clock will replay differently and nothing here will catch it.

### Bounds on the formal evidence

The model is bounded — four steps, four invocations, one run, one key, one consumer — and it
abstracts wall-clock time, batch sizes and retry counts. An exhaustive check of a bounded model is
not a proof about the unbounded system; it is a very thorough search for a counterexample in the
region where counterexamples of this shape live. The assumptions it rests on are enumerated in
[`formal/RESULTS.md`](../formal/RESULTS.md#what-the-model-assumes), and one of them — that a
journalled step failure repeats on replay — is a claim about the platform rather than about this
code.

---

<sub>[1] W. M. P. van der Aalst, "The Application of Petri Nets to Workflow Management",
_Journal of Circuits, Systems and Computers_ 8(1):21–66, 1998. The soundness criterion is
Definition 4.5; option to complete and proper completion are its first two conditions.</sub>
