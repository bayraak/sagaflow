# bench

```bash
bun run bench
```

Measures what sagaflow costs, prints it, and writes `results/<version>.json`.

## What is measured

Nine subjects: three step counts (1, 5, 20) against three backings.

| Subject  | What it is                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `plain`  | The same calls, awaited, with nothing around them. The floor.                                        |
| `memory` | The engine with the in-memory journal. Engine overhead with no storage in the way.                   |
| `sqlite` | The engine with the `bun:sqlite` journal at `:memory:`. Real statements, real transactions, no disk. |

Each saga is declared through the public surface — `sagaflow()`, `saga()`, `step()` — so what
is counted is what a caller actually pays: the ambient scope, the run record, a write per step,
the compensation registered from each step's return value, the envelope minted for the run's own
completion, and the one atomic write that closes it. Every step declares an undo, which is never
run; registering it is part of the cost.

Two things are deliberately excluded. **The work itself**, because it is yours. **Delivery**,
because it is your queue's — no sink is configured, so no drain happens. A number that included
an in-process sink would be measuring an array push, and one that included a real queue would be
measuring the queue.

## Method

- **Clock**: `Bun.nanoseconds`, through [mitata](https://github.com/evanwashere/mitata), which
  generates JIT-friendly measurement loops. Every figure is nanoseconds.
- **Warm-up**: 2000 runs per subject before any sample is kept, on top of mitata's own.
- **Sampling**: 642 ms of samples per subject, which is hundreds of thousands of runs for the
  memory journal and a few thousand for SQLite.
- **Per-sample state**: each sample starts from an empty journal. The reset runs as a mitata
  computed parameter, which is evaluated **outside** the timed region. Batching is switched off
  (`batch_threshold: 0`) because a batched loop would do all the resets in one block and all the
  runs in another, which would put the resets back inside the timing.
- **Percentiles**: computed here from mitata's raw samples, not read off its summary, so p50,
  p95 and p99 all come from one definition. mitata does not report p95.
- **Per-step cost**: the slope between the 1-step and 20-step medians, `(p50₂₀ − p50₁) / 19`.
  Dividing a run by its step count instead would fold the fixed cost of opening and closing a
  run into every step and overstate what a step costs.

Override with `SAGAFLOW_BENCH_MS` (sampling time per subject) and `SAGAFLOW_BENCH_WARMUP`.

## What is not here, and will not be

**No comparisons with other libraries.** A number measured on this laptop against a number
somebody else measured on theirs is not a comparison. Absolute numbers, one machine, the machine
named.

**No disk.** SQLite runs at `:memory:`. A file-backed database with the default sync mode does an
fsync per transaction, and the resulting figure describes the disk rather than sagaflow.

The one comparison that does survive leaving this machine is in
[`what-you-must-write/`](./what-you-must-write/README.md): the same mutation, with the same six
guarantees, implemented three ways and counted with a line counter. That number is identical
everywhere.

## Machine

Results are only meaningful next to the machine that produced them, so every results file
carries one:

```
Apple M1 Pro · arm64 · darwin · bun 1.4.0
```
