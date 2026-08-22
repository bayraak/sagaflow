--------------------------------- MODULE Sagaflow ---------------------------------
(***************************************************************************)
(* A model of one sagaflow run.                                            *)
(*                                                                         *)
(* What is modelled: a bounded run of N steps; a journal whose finish is    *)
(* one atomic batch that closes the run AND writes its events; a sink that  *)
(* may refuse; the run's own drain; the outbox sweeper; the abandoned-run   *)
(* sweeper; a consumer that deduplicates by envelope id; a durable executor *)
(* that may crash at any point and be re-invoked, replaying memoised steps  *)
(* from the top; a cancellation flag read at step boundaries; and an        *)
(* idempotency key held by running and completed runs only.                 *)
(*                                                                         *)
(* The specification is deliberately small. It is not a model of the        *)
(* TypeScript; it is a model of the orderings the TypeScript is arranged to *)
(* produce, so that a checker can say whether any interleaving of them      *)
(* reaches a state the guarantees forbid. RESULTS.md records what it said,  *)
(* including the three places where the answer was yes.                     *)
(***************************************************************************)
EXTENDS FiniteSets, Naturals, Sequences

CONSTANTS
    N,                  \* steps in the modelled run
    MaxInvocations,     \* bound on how many times the durable body is invoked
    MaxLostMarks,       \* bound on lost markEventsDispatched writes
    DeterministicIds,   \* TRUE: envelope ids are ${runId}:${ordinal}; FALSE: fresh per invocation
    JournalledFailures, \* TRUE: a step's failure is journalled and repeats on replay
    LiveSweep,          \* TRUE: the abandoned-run sweeper may close a run that is still alive
    Cancellable,        \* TRUE: the run may be asked to stop
    EntryGuard,         \* TRUE: the journal can read a run back, so a closed run is not re-walked
    TrailAtEntry        \* TRUE: the journal can read a trail back, so the run's history is known

ASSUME N \in Nat /\ N >= 1
ASSUME MaxInvocations \in Nat /\ MaxInvocations >= 1
ASSUME MaxLostMarks \in Nat
ASSUME DeterministicIds \in BOOLEAN
ASSUME JournalledFailures \in BOOLEAN
ASSUME LiveSweep \in BOOLEAN
ASSUME Cancellable \in BOOLEAN
ASSUME EntryGuard \in BOOLEAN
ASSUME TrailAtEntry \in BOOLEAN

Steps == 1..N

\* 0..N-1 are the steps' emissions and N is the completed lifecycle. The two
\* above them are the closures that are NOT emissions from the body: the
\* compensated announcement, and the abandoned-run sweeper's. They are
\* identified by what they are rather than by a position in the run's emission
\* sequence, which is what stops two different closers reaching for one id.
CompensatedOrdinal == N + 1
SweptOrdinal       == N + 2
Ordinals == 0..(N + 2)

Running == "running"
TerminalStatuses == {"completed", "compensated", "failed", "cancelled"}
HeldStatuses == {"running", "completed"}   \* the statuses that hold the idempotency key
Kinds == {"step", "completed", "compensated"}
Phases == {"body", "unwind", "finish", "committed", "drain", "stopped", "dead"}
Causes == {"none", "failure", "cancel", "output"}

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

RECURSIVE ReverseSorted(_)
ReverseSorted(S) ==
    IF S = {} THEN << >> ELSE LET m == Max(S) IN <<m>> \o ReverseSorted(S \ {m})

(***************************************************************************)
(* An outbox row is keyed by its envelope id. `insert ... on conflict (id)  *)
(* do nothing` is what makes a repeated finish land on rows that already    *)
(* exist rather than writing a second set, so insertion here is by id too.  *)
(***************************************************************************)
Insert(rows, row) == IF \E existing \in rows : existing.id = row.id THEN rows ELSE rows \cup {row}

RECURSIVE InsertAll(_, _)
InsertAll(rows, incoming) ==
    IF incoming = {}
      THEN rows
      ELSE LET row == CHOOSE candidate \in incoming : TRUE
           IN InsertAll(Insert(rows, row), incoming \ {row})

VARIABLES
    mode,               \* "inline" | "durable"
    status,             \* the run row's status
    closes,             \* how many times the run row moved from running to terminal
    stepRec,            \* the journalled outcome of each step
    stepMemo,           \* whether the platform checkpointed each step
    undoDone,           \* the steps whose undo has succeeded
    undoOrder,          \* the order those undos succeeded in
    undoRefused,        \* the steps whose undo refused, recorded in the trail
    unwindBegan,        \* the trail holds a compensation: the run started going down
    cursor,             \* the next step index in the current invocation
    phase,
    minted,             \* the current invocation's envelope ordinal counter
    invocations,
    unwindCause,
    finishTarget,       \* the status the finish is about to write
    finishMemo,         \* whether the platform checkpointed the reserved finish-run step
    finishCommits,      \* how many times a finish batch committed
    outbox,             \* the outbox rows
    outboxAtFirstClose, \* the outbox as it stood when the run was first closed
    dispatched,         \* the envelope ids marked delivered
    seenIds,            \* the ids the consumer recognises
    appliedFacts,       \* the facts the consumer has acted on
    doubleApplied,      \* set when the consumer acts on a fact it has already acted on
    lostMarks,
    cancelReq,
    secondClaim,        \* "none" | "deduped" | "admitted"
    completeAtClose,    \* was every completed step undone, once, when the run closed
    orderedAtClose,     \* were those undos in reverse start order when the run closed
    effectAfterClose,   \* did a step run for real after the run had already closed
    outputAccepted      \* whether the output schema accepts this body's return value

journalVars  == <<status, closes, outbox, outboxAtFirstClose>>
consumerVars == <<dispatched, seenIds, appliedFacts, doubleApplied, lostMarks>>
runVars      == <<cursor, phase, minted, unwindCause, finishTarget>>
memoVars     ==
    <<stepRec, stepMemo, undoDone, undoOrder, undoRefused, unwindBegan, finishMemo,
      finishCommits>>
envVars      == <<mode, invocations, cancelReq, secondClaim>>
closeVars    == <<completeAtClose, orderedAtClose, effectAfterClose>>
vars ==
    <<status, closes, outbox, outboxAtFirstClose,
      dispatched, seenIds, appliedFacts, doubleApplied, lostMarks,
      cursor, phase, minted, unwindCause, finishTarget,
      stepRec, stepMemo, undoDone, undoOrder, undoRefused, unwindBegan, finishMemo,
      finishCommits,
      mode, invocations, cancelReq, secondClaim,
      completeAtClose, orderedAtClose, effectAfterClose, outputAccepted>>

(***************************************************************************)
(* Envelope identity. The whole of guarantee 3 rests on this being a        *)
(* function of the run rather than of when the envelope happened to be      *)
(* built: a re-invoked body walks the same emissions in the same order and  *)
(* arrives at the same ids. Setting DeterministicIds to FALSE models what   *)
(* the engine did before the extraction closed the gap -- a fresh id per    *)
(* invocation, which the consumer has no way to recognise as a repeat.      *)
(***************************************************************************)
Generation == IF DeterministicIds THEN 0 ELSE invocations
Envelope(ordinal, kind) == [id |-> <<ordinal, Generation>>, ord |-> ordinal, kind |-> kind]

StepFacts      == { [ord |-> i - 1, kind |-> "step"] : i \in Steps }
CompletedFacts == StepFacts \cup { [ord |-> N, kind |-> "completed"] }
OutboxFacts    == { [ord |-> row.ord, kind |-> row.kind] : row \in outbox }
Undoable       == { i \in Steps : stepRec[i] = "done" }

(***************************************************************************)
(* A step that the platform has checkpointed replays from the journal and   *)
(* never runs again. A step whose failure was journalled fails the same way *)
(* on replay: deterministic replay is the assumption every durable engine   *)
(* makes, and it is assumption A2 in RESULTS.md rather than a theorem.      *)
(***************************************************************************)
Memoised(i) == stepMemo[i] /\ stepRec[i] = "done"
Refails(i)  == JournalledFailures /\ stepRec[i] = "failed"
Fresh(i)    == ~Memoised(i) /\ ~Refails(i)

Init ==
    /\ mode \in {"inline", "durable"}
    /\ status = Running
    /\ closes = 0
    /\ stepRec = [i \in Steps |-> "pending"]
    /\ stepMemo = [i \in Steps |-> FALSE]
    /\ undoDone = {}
    /\ undoOrder = << >>
    /\ undoRefused = {}
    /\ unwindBegan = FALSE
    /\ cursor = 1
    /\ phase = "body"
    /\ minted = 0
    /\ invocations = 1
    /\ unwindCause = "none"
    /\ finishTarget = "none"
    /\ finishMemo = FALSE
    /\ finishCommits = 0
    /\ outbox = {}
    /\ outboxAtFirstClose = {}
    /\ dispatched = {}
    /\ seenIds = {}
    /\ appliedFacts = {}
    /\ doubleApplied = FALSE
    /\ lostMarks = 0
    /\ cancelReq = FALSE
    /\ secondClaim = "none"
    /\ completeAtClose = TRUE
    /\ orderedAtClose = TRUE
    /\ effectAfterClose = FALSE
    \* The output schema is a function of the value the body returns. With
    \* every step memoised, a re-invocation returns the same value and gets
    \* the same verdict, so the verdict is fixed for the run rather than
    \* redecided per invocation.
    /\ outputAccepted \in BOOLEAN

(***************************************************************************)
(* The body                                                                 *)
(*                                                                         *)
(* A memoised step contributes its events again -- they travel home in the  *)
(* step's memoised result -- but its body does not run, so recordStep is    *)
(* not called and the cancellation flag is not read at that boundary.       *)
(***************************************************************************)
StepReplay(i) ==
    /\ phase = "body"
    /\ cursor = i
    /\ Memoised(i)
    /\ cursor' = i + 1
    /\ minted' = minted + 1
    /\ UNCHANGED <<phase, unwindCause, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

StepRefails(i) ==
    /\ phase = "body"
    /\ cursor = i
    /\ Refails(i)
    /\ phase' = "unwind"
    /\ unwindCause' = "failure"
    /\ UNCHANGED <<cursor, minted, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

StepSucceeds(i) ==
    /\ phase = "body"
    /\ cursor = i
    /\ Fresh(i)
    /\ ~unwindBegan
    /\ stepRec' = [stepRec EXCEPT ![i] = "done"]
    \* A step that returns to the body has been checkpointed: writing the
    \* result IS what the platform's step primitive does before it returns.
    \* The window where an effect happened and the step reported failure
    \* anyway is a retry, covered by StepFails -- and it is the window
    \* ctx.idempotencyKey exists for.
    /\ stepMemo' = [stepMemo EXCEPT ![i] = (mode = "durable")]
    /\ minted' = minted + 1
    \* The step's events are minted and its undo is registered before the
    \* cancellation throw, so a cancelled run leaves nothing standing.
    /\ \/ /\ cancelReq
          /\ phase' = "unwind"
          /\ unwindCause' = "cancel"
          /\ cursor' = cursor
       \/ /\ ~cancelReq
          /\ phase' = phase
          /\ unwindCause' = unwindCause
          /\ cursor' = i + 1
    /\ UNCHANGED finishTarget
    /\ UNCHANGED <<undoDone, undoOrder, undoRefused, unwindBegan, finishMemo, finishCommits>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED envVars
    /\ effectAfterClose' = (effectAfterClose \/ status # Running)
    /\ UNCHANGED <<completeAtClose, orderedAtClose>>
    /\ UNCHANGED outputAccepted

StepFails(i) ==
    /\ phase = "body"
    /\ cursor = i
    /\ Fresh(i)
    /\ ~unwindBegan
    /\ stepRec' = [stepRec EXCEPT ![i] = "failed"]
    /\ phase' = "unwind"
    /\ unwindCause' = "failure"
    /\ UNCHANGED <<cursor, minted, finishTarget>>
    /\ UNCHANGED
           <<stepMemo, undoDone, undoOrder, undoRefused, unwindBegan, finishMemo, finishCommits>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED envVars
    /\ effectAfterClose' = (effectAfterClose \/ status # Running)
    /\ UNCHANGED <<completeAtClose, orderedAtClose>>
    /\ UNCHANGED outputAccepted

(***************************************************************************)
(* A run that had already begun unwinding is not carried any further        *)
(* forward, and is not allowed to finish.                                   *)
(*                                                                         *)
(* Replaying the memoised steps is right -- that is how their undos are     *)
(* registered again -- but a step that never ran must not run now: a        *)
(* memoised step does not call recordStep and so does not re-read the flag  *)
(* that started the unwind, and the new step's undo would land after an     *)
(* undo that started EARLIER had already succeeded. And when every step is  *)
(* memoised there is no fresh step to stop at, so the body would otherwise  *)
(* reach the end and close the run COMPLETED with all of its effects        *)
(* already reversed.                                                        *)
(***************************************************************************)
ResumeUnwinding ==
    /\ phase = "body"
    /\ unwindBegan
    /\ \/ cursor = N + 1
       \/ \E i \in Steps : cursor = i /\ Fresh(i)
    /\ phase' = "unwind"
    /\ unwindCause' = "failure"
    /\ UNCHANGED <<cursor, minted, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

BodyCompletes ==
    /\ phase = "body"
    /\ cursor = N + 1
    /\ ~unwindBegan
    /\ outputAccepted
    /\ phase' = "finish"
    /\ finishTarget' = "completed"
    /\ minted' = minted + 1
    /\ UNCHANGED <<cursor, unwindCause>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

\* A body that returns a value the output schema refuses is a body that
\* failed, however cheerfully it returned, and goes down the unwinding path.
OutputRefused ==
    /\ phase = "body"
    /\ cursor = N + 1
    /\ ~unwindBegan
    /\ ~outputAccepted
    /\ phase' = "unwind"
    /\ unwindCause' = "output"
    /\ UNCHANGED <<cursor, minted, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

(***************************************************************************)
(* Unwinding                                                                *)
(*                                                                         *)
(* Backwards, by the order the steps were STARTED in. Every undo is         *)
(* attempted even when an earlier one refuses. An undo that succeeded is    *)
(* checkpointed and is skipped on a replay. One that refused was not        *)
(* checkpointed, but it WAS recorded in the trail, and a later invocation   *)
(* reads that and treats the refusal as final: the run is failed, which     *)
(* says truthfully that something was left standing.                        *)
(***************************************************************************)
Outstanding == Undoable \ (undoDone \cup undoRefused)

UndoSucceeds ==
    /\ phase = "unwind"
    /\ Outstanding # {}
    /\ undoDone' = undoDone \cup {Max(Outstanding)}
    /\ undoOrder' = Append(undoOrder, Max(Outstanding))
    /\ UNCHANGED <<undoRefused, stepRec, stepMemo, finishMemo, finishCommits>>
    /\ unwindBegan' = TRUE
    /\ UNCHANGED runVars
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

UndoRefuses ==
    /\ phase = "unwind"
    /\ Outstanding # {}
    /\ undoRefused' = undoRefused \cup {Max(Outstanding)}
    /\ UNCHANGED <<undoDone, undoOrder, stepRec, stepMemo, finishMemo, finishCommits>>
    /\ unwindBegan' = TRUE
    /\ UNCHANGED runVars
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

\* Somebody changing their mind and something breaking are different facts.
\* A run asked to stop that came all the way back is cancelled; one that left
\* something standing is failed, whatever asked it to stop.
UnwindCompletes ==
    /\ phase = "unwind"
    /\ Outstanding = {}
    /\ phase' = "finish"
    /\ finishTarget' = IF undoRefused # {}
                         THEN "failed"
                         ELSE IF unwindCause = "cancel" THEN "cancelled" ELSE "compensated"
    /\ UNCHANGED <<cursor, minted, unwindCause>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

(***************************************************************************)
(* The finish                                                               *)
(*                                                                         *)
(* One atomic batch: the run closes and its events are written together, so *)
(* a completed run whose audit trail was lost is not a representable state. *)
(* The status update is guarded on the run still being running, so a late   *)
(* finish cannot reopen a run somebody else has already closed.             *)
(*                                                                         *)
(* Committing the batch and checkpointing the reserved finish-run step are  *)
(* two separate events, and a crash between them is the case a durable      *)
(* re-invocation actually produces.                                         *)
(***************************************************************************)
\* The closure announcement is a fact about the RUN, so its id is a function of
\* the run and not of how far this invocation happened to walk. A longer walk
\* used to mint it at a higher ordinal -- a different id, which the outbox's
\* conflict clause cannot recognise as the same announcement.
FinishEvents ==
    IF finishTarget = "completed"
      THEN { Envelope(i - 1, "step") : i \in Steps } \cup { Envelope(N, "completed") }
      ELSE { Envelope(CompensatedOrdinal, "compensated") }

FinishCommit ==
    /\ phase = "finish"
    /\ ~(mode = "durable" /\ finishMemo)
    /\ LET written == InsertAll(outbox, FinishEvents)
       IN /\ outbox' = written
          /\ \/ /\ status = Running
                /\ status' = finishTarget
                /\ closes' = closes + 1
                /\ outboxAtFirstClose' = written
                /\ completeAtClose' =
                       (undoDone = Undoable /\ Len(undoOrder) = Cardinality(undoDone))
                /\ orderedAtClose' = (undoOrder = ReverseSorted(undoDone))
             \/ /\ status # Running
                /\ UNCHANGED <<status, closes, outboxAtFirstClose>>
                /\ UNCHANGED <<completeAtClose, orderedAtClose>>
    /\ finishCommits' = finishCommits + 1
    /\ phase' = "committed"
    /\ UNCHANGED <<cursor, minted, unwindCause, finishTarget>>
    /\ UNCHANGED <<stepRec, stepMemo, undoDone, undoOrder, undoRefused, unwindBegan, finishMemo>>
    /\ UNCHANGED consumerVars
    /\ UNCHANGED envVars
    /\ UNCHANGED effectAfterClose
    /\ UNCHANGED outputAccepted

\* The finish went through the runner like any other step, so an instance
\* invoked again for the same run finds it already done.
FinishReplay ==
    /\ phase = "finish"
    /\ mode = "durable"
    /\ finishMemo
    /\ phase' = IF finishTarget = "completed" THEN "drain" ELSE "stopped"
    /\ UNCHANGED <<cursor, minted, unwindCause, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

FinishCheckpointed ==
    /\ phase = "committed"
    /\ finishMemo' = (mode = "durable")
    /\ phase' = IF finishTarget = "completed" THEN "drain" ELSE "stopped"
    /\ UNCHANGED <<cursor, minted, unwindCause, finishTarget>>
    /\ UNCHANGED
           <<stepRec, stepMemo, undoDone, undoOrder, undoRefused, unwindBegan, finishCommits>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

(***************************************************************************)
(* Delivery                                                                 *)
(*                                                                         *)
(* Sending and recording the send are one act per envelope here, and the    *)
(* record may be lost -- which is the whole of at-least-once: a row that was *)
(* sent but not marked is sent again, and the consumer recognises it by its *)
(* id and discards it. Batching is abstracted away; it is a cost, not a     *)
(* correctness property, and it is asserted exactly in test/cost-model.     *)
(***************************************************************************)
DeliverEnvelope(row) ==
    /\ \/ /\ row.id \in seenIds
          /\ UNCHANGED <<seenIds, appliedFacts, doubleApplied>>
       \/ /\ row.id \notin seenIds
          /\ seenIds' = seenIds \cup {row.id}
          /\ appliedFacts' = appliedFacts \cup {row.ord}
          /\ doubleApplied' = (doubleApplied \/ row.ord \in appliedFacts)
    /\ \/ /\ dispatched' = dispatched \cup {row.id}
          /\ UNCHANGED lostMarks
       \/ /\ lostMarks < MaxLostMarks
          /\ lostMarks' = lostMarks + 1
          /\ UNCHANGED dispatched

Undelivered == { row \in outbox : row.id \notin dispatched }

\* The run's own drain, on the way out of a successful finish.
DrainOne ==
    /\ phase = "drain"
    /\ \E row \in Undelivered : DeliverEnvelope(row)
    /\ UNCHANGED runVars
    /\ UNCHANGED journalVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

\* The drain finishing, or the sink refusing it. Either way the run is over:
\* its mutation committed, the rows are on the table, and the sweeper carries
\* whatever did not go.
DrainEnds ==
    /\ phase = "drain"
    /\ phase' = "stopped"
    /\ UNCHANGED <<cursor, minted, unwindCause, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

SweepOutbox ==
    /\ \E row \in Undelivered : DeliverEnvelope(row)
    /\ UNCHANGED runVars
    /\ UNCHANGED journalVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

(***************************************************************************)
(* The abandoned-run sweeper. An inline run lives inside one request; if the *)
(* process carrying it dies, nothing is left to close it. Durable runs are   *)
(* never touched at any age.                                                *)
(*                                                                         *)
(* "The run emitted nothing -- it never reached its finish" is sound about a *)
(* run that really is dead and unsound as an identity: ordinal 0 is also the *)
(* id of an emission a live run really made. The sweep is identified by what *)
(* it is instead, so the two cannot collide.                                 *)
(***************************************************************************)
SweepAbandoned ==
    /\ mode = "inline"
    /\ status = Running
    /\ (phase = "dead" \/ LiveSweep)
    /\ LET written == Insert(outbox, Envelope(SweptOrdinal, "compensated"))
       IN /\ outbox' = written
          /\ outboxAtFirstClose' = written
    /\ status' = "failed"
    /\ closes' = closes + 1
    /\ completeAtClose' = (undoDone = Undoable /\ Len(undoOrder) = Cardinality(undoDone))
    /\ orderedAtClose' = (undoOrder = ReverseSorted(undoDone))
    /\ UNCHANGED runVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED effectAfterClose
    /\ UNCHANGED outputAccepted

Crash ==
    /\ phase \in {"body", "unwind", "finish", "committed", "drain"}
    /\ phase' = "dead"
    /\ UNCHANGED <<cursor, minted, unwindCause, finishTarget>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED envVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

\* The platform re-invokes the instance. It knows nothing about the run's
\* status, so it may re-invoke a run whose finish already committed -- which
\* is why the invocation reads the run before it runs anything, and stops if
\* it has already ended. Replaying memoised steps would be harmless; walking
\* PAST the point where the invocation that closed the run stopped is not,
\* and a memoised step never re-reads the cancellation flag that stopped it.
\*
\* The trail is read in the same breath, so an undo this run already recorded
\* as refused is not attempted again: retrying it would land after the undos
\* that came later in reverse order have already succeeded and been memoised.
Reinvoke ==
    /\ mode = "durable"
    /\ phase = "dead"
    /\ invocations < MaxInvocations
    /\ invocations' = invocations + 1
    /\ phase' = IF EntryGuard /\ status # Running THEN "stopped" ELSE "body"
    /\ cursor' = 1
    /\ minted' = 0
    /\ unwindCause' = "none"
    /\ finishTarget' = "none"
    \* Both read from the trail, so both are what a journal WITHOUT listRunSteps loses.
    /\ undoRefused' = IF TrailAtEntry THEN undoRefused ELSE {}
    /\ unwindBegan' = IF TrailAtEntry THEN unwindBegan ELSE FALSE
    /\ UNCHANGED <<stepRec, stepMemo, undoDone, undoOrder, finishMemo, finishCommits>>
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED <<mode, cancelReq, secondClaim>>
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

\* Cooperative, and only while the run is running: a run that has already
\* ended cannot be stopped.
RequestCancel ==
    /\ Cancellable
    /\ ~cancelReq
    /\ status = Running
    /\ cancelReq' = TRUE
    /\ UNCHANGED <<mode, invocations, secondClaim>>
    /\ UNCHANGED runVars
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

\* Somebody asks for the same work under the same key. A held key is answered
\* with the run that holds it; a released one lets the work be asked for again.
SecondClaim ==
    /\ secondClaim = "none"
    /\ secondClaim' = IF status \in HeldStatuses THEN "deduped" ELSE "admitted"
    /\ UNCHANGED <<mode, invocations, cancelReq>>
    /\ UNCHANGED runVars
    /\ UNCHANGED journalVars
    /\ UNCHANGED consumerVars
    /\ UNCHANGED memoVars
    /\ UNCHANGED closeVars
    /\ UNCHANGED outputAccepted

Next ==
    \/ \E i \in Steps :
           \/ StepReplay(i)
           \/ StepRefails(i)
           \/ StepSucceeds(i)
           \/ StepFails(i)
    \/ ResumeUnwinding
    \/ BodyCompletes
    \/ OutputRefused
    \/ UndoSucceeds
    \/ UndoRefuses
    \/ UnwindCompletes
    \/ FinishCommit
    \/ FinishReplay
    \/ FinishCheckpointed
    \/ DrainOne
    \/ DrainEnds
    \/ SweepOutbox
    \/ SweepAbandoned
    \/ Crash
    \/ Reinvoke
    \/ RequestCancel
    \/ SecondClaim

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* The invariants                                                           *)
(***************************************************************************)
TypeOK ==
    /\ mode \in {"inline", "durable"}
    /\ status \in ({Running} \cup TerminalStatuses)
    /\ closes \in 0..1
    /\ stepRec \in [Steps -> {"pending", "done", "failed"}]
    /\ stepMemo \in [Steps -> BOOLEAN]
    /\ undoDone \subseteq Steps
    /\ undoRefused \subseteq Steps
    /\ unwindBegan \in BOOLEAN
    /\ Len(undoOrder) <= N
    /\ \A k \in 1..Len(undoOrder) : undoOrder[k] \in Steps
    /\ cursor \in 1..(N + 1)
    /\ phase \in Phases
    /\ minted \in 0..(N + 1)
    /\ invocations \in 1..MaxInvocations
    /\ unwindCause \in Causes
    /\ finishTarget \in ({"none"} \cup TerminalStatuses)
    /\ finishMemo \in BOOLEAN
    /\ finishCommits \in 0..(MaxInvocations + 1)
    /\ dispatched \subseteq { row.id : row \in outbox }
    /\ appliedFacts \subseteq Ordinals
    /\ doubleApplied \in BOOLEAN
    /\ lostMarks \in 0..MaxLostMarks
    /\ cancelReq \in BOOLEAN
    /\ secondClaim \in {"none", "deduped", "admitted"}
    /\ completeAtClose \in BOOLEAN
    /\ orderedAtClose \in BOOLEAN
    /\ effectAfterClose \in BOOLEAN
    /\ outputAccepted \in BOOLEAN

\* I1. A run reaches exactly one terminal status. The companion action
\* property NeverReopens says it never goes back.
I1_FinishExactlyOnce ==
    /\ closes <= 1
    /\ (closes = 0) <=> (status = Running)
    /\ (closes = 1) => (status \in TerminalStatuses)

NeverReopens == [][ (status \in TerminalStatuses) => (status' = status) ]_vars

\* I2. Completed if and only if the events are queued. One atomic batch,
\* so "completed with its audit trail lost" is unreachable.
I2_NoCompletedWithoutEvents ==
    (status = "completed") => (CompletedFacts \subseteq OutboxFacts)

\* I3. Exactly-once EFFECT under at-least-once delivery: no fact is ever
\* acted on twice, however many times its envelope is delivered.
I3_ExactlyOnceEffect == ~doubleApplied

\* The other half of exactly-once: once every row has been marked delivered,
\* every fact in the outbox has been acted on.
I3b_DeliveredOnceWhenDrained ==
    (Undelivered = {}) => (appliedFacts = { row.ord : row \in outbox })

\* I4. Compensation completeness, AS FIRST STATED: a run that ends
\* compensated or cancelled has undone every step that completed, each
\* exactly once. TLC refutes this as a state invariant -- see RESULTS.md
\* finding F1. It is kept exactly as written, because the counterexample is
\* the point: the engine does not stop a closed run's body being walked
\* again by a re-invocation, and steps that had not run then run for real.
I4_CompensationCompleteness ==
    (status \in {"compensated", "cancelled"}) =>
        /\ undoDone = Undoable
        /\ Len(undoOrder) = Cardinality(undoDone)

\* The ordering half of I4, as first stated. Also refuted -- finding F1.
I4b_ReverseStartOrder ==
    (status \in {"compensated", "cancelled"}) => (undoOrder = ReverseSorted(undoDone))

\* I4c/I4d. The same two claims evaluated AT THE MOMENT THE RUN CLOSED,
\* which is the honest statement of what the engine guarantees: the closing
\* batch records an outcome that was true of the run when it was written.
\* What a later re-invocation does to the world afterwards is finding F1,
\* and is measured by I8 rather than hidden here.
I4c_CompleteAtClose ==
    (status \in {"compensated", "cancelled"}) => completeAtClose

I4d_ReverseStartOrderAtClose ==
    (status \in {"compensated", "cancelled"}) => orderedAtClose

\* I5. Re-invocation idempotency: however many times the body is invoked,
\* the outbox holds one set of envelopes and never grows after the close.
I5_ReinvocationIdempotency == (closes >= 1) => (outbox = outboxAtFirstClose)

\* I6. The idempotency key is held by at most one run at a time. This is
\* what the `and status = 'running'` guard on the finish exists to protect.
I6_KeyExclusivity == ~(secondClaim = "admitted" /\ status \in HeldStatuses)

\* I7. One closer per run, and the announcement agrees with the record.
I7_OneClosureAnnounced ==
    /\ Cardinality({ fact \in OutboxFacts : fact.kind \in {"completed", "compensated"} }) <= 1
    /\ (status = "completed") => ~(\E fact \in OutboxFacts : fact.kind = "compensated")
    /\ (status \in {"compensated", "failed", "cancelled"})
         => ~(\E fact \in OutboxFacts : fact.kind = "completed")

\* I8. Nothing the body does happens after the run has been closed.
I8_NoEffectAfterClose == ~effectAfterClose

\* I9. A run that closed COMPLETED undid nothing. The caller of a completed
\* run is entitled to believe its effects are standing, and a run that
\* unwound and then reported success is the worst answer this engine could
\* give: every effect reversed, and the caller told it worked.
I9_CompletedUndidNothing == (status = "completed") => (undoDone = {})

=============================================================================
