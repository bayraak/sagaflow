# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Getting set up

```bash
bun install
bun test          # the core suite — milliseconds, no platform, no network
bun run typecheck
bun run lint
bun run fmt:check
bun run build
```

Bun is the toolchain. Node users can run everything except the test scripts.

## The one rule

**Write the failing test first.** Every behaviour in this package arrived as a test that failed,
then an implementation that made it pass. A pull request that adds behaviour without a test that
would have failed before it is not going to be merged, however good the behaviour is — a test
written after the code validates what was built rather than what was meant.

If you are changing behaviour rather than adding it, the existing test that pins the old
behaviour should change in the same commit, and the commit message should say why the old
behaviour was wrong.

## What good looks like here

- **No runtime dependencies.** Not one, not for convenience. Development and test dependencies
  are fine.
- **No `any`, no `@ts-ignore`, no `@ts-expect-error`.** Strict TypeScript throughout.
- **Test behaviour, not implementation.** Assert on the rows the journal holds and the values
  callers receive, never on which internal function was called.
- **No network in any test.** The core suite runs against in-memory adapters; the workerd suite
  runs against local emulation only.
- **Comments explain why, not what.** The code says what it does. A comment earns its place by
  recording a decision, a hazard, or the reason something is not the obvious shape.
- **Conventional Commits** — `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.

## Adding an adapter

The three seams are `RunJournal`, `EventSink` and `StepPrimitive`. A journal for a new store is
the most useful contribution there is; see [`docs/adapters.md`](./docs/adapters.md) and
[`docs/journal.md`](./docs/journal.md) for the contract, and `src/memory` for a worked reference
that enforces every rule a real table has to.

## Changing the engine

Two things are load-bearing and easy to break without noticing:

1. **Determinism under re-invocation.** A durable body runs again from the top; anything the
   engine does must produce the same result the second time. If your change touches envelope ids,
   the ordinal counter, or the order of steps, add a case to `test/engine.replay.test.ts`.
2. **The atomicity of the finish.** The run closing and its events being written are one call
   because they are one write underneath. Nothing may be moved out of that call.
