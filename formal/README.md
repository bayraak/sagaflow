# The formal model

A TLA+ specification of one sagaflow run — the run lifecycle, the transactional outbox and the two
sweepers — model-checked with TLC.

The tests in `test/` prove that the engine does the right thing along the paths a test can walk.
This model exists for the paths a test cannot walk: the interleavings. A crash between the finish
batch committing and the platform checkpointing the step that committed it. A re-invocation that
reaches a step the first invocation never did. A sweeper closing a run at the same instant the run
closes itself. A queue delivering an envelope the consumer has already seen. Those orderings are
real, they are rare, and enumerating them by hand is how a guarantee quietly becomes a hope.

| File                                               | What it is                                          |
| -------------------------------------------------- | --------------------------------------------------- |
| [`Sagaflow.tla`](./Sagaflow.tla)                   | the model and its invariants                        |
| [`Sagaflow.cfg`](./Sagaflow.cfg)                   | every invariant this study states — six are refuted |
| [`SagaflowProven.cfg`](./SagaflowProven.cfg)       | the invariants that hold, exhaustively              |
| [`SagaflowDeep.cfg`](./SagaflowDeep.cfg)           | the same, one step and one invocation deeper        |
| [`SagaflowNoCancel.cfg`](./SagaflowNoCancel.cfg)   | confines finding F1 to the cancellation path        |
| [`SagaflowRandomIds.cfg`](./SagaflowRandomIds.cfg) | ablation: what deterministic envelope ids buy       |
| [`SagaflowLiveSweep.cfg`](./SagaflowLiveSweep.cfg) | ablation: a sweeper window shorter than a request   |
| [`RESULTS.md`](./RESULTS.md)                       | every run, every verdict, every counterexample      |

## Running it

```sh
./fetch-tools.sh   # once
./check.sh
```

`check.sh` runs all six models and compares each outcome against what `RESULTS.md` records. It
exits non-zero only when a model behaves differently from the record — including when a model
that is supposed to find a counterexample stops finding one, which is how the findings get closed.

## Why the jar is not checked in

`tla2tools.jar` is MIT at its own source, but the published jar bundles Eclipse components under
EPL-2.0. This package is MIT with an empty `dependencies` field, and putting an EPL obligation
inside it to save one `curl` is a bad trade. `fetch-tools.sh` pins the release; `formal/tools/` is
ignored.

## What is modelled, and what is not

Modelled: a bounded run of N steps; a journal whose finish is one atomic batch that closes the run
and writes its events together; a sink that may refuse; the run's own drain; the outbox sweeper;
the abandoned-run sweeper; a consumer that deduplicates by envelope id; a durable executor that may
crash anywhere and be re-invoked, replaying memoised steps from the top; a cancellation flag read
at step boundaries; an idempotency key held by running and completed runs only.

Not modelled: two runs at once, wall-clock durations, batch sizes, retry counts, and the atomicity
of an external call against the record of it. Each of those is listed with its consequence under
"What the model assumes" in [`RESULTS.md`](./RESULTS.md), and the ones that matter to a reader of
the guarantees are repeated in [`../docs/guarantees.md`](../docs/guarantees.md).

The model is not a model of the TypeScript. It is a model of the orderings the TypeScript is
arranged to produce. When the two disagree, that is a finding about one of them, and
`RESULTS.md` says which.
