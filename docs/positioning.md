# Where sagaflow sits

This page is about choosing. It says what sagaflow is best at, what it is not best at, and which
other tool to reach for when the answer is not this one. Product by product, in more detail and
with the same honesty, is [`comparison.md`](./comparison.md).

## The claim

**Make every write a saga.** Not the occasional long-running job — every write.

That is only a reasonable thing to ask of anybody if it is cheap and if the promises are
checkable, so both are on the table before you decide anything:

- **The cost is counted, not described.** Journal round trips per run, statements per finish
  batch, sends per hundred events, steps re-executed on a re-invocation. Asserted exactly in
  [`test/cost-model.test.ts`](../test/cost-model.test.ts), so a change to any of them is a
  reviewed decision rather than drift.
- **The guarantees are six, each with a test you can read.** They are listed in the
  [README](../README.md#exactly-what-it-guarantees) with a link per row. `docs/guarantees.md` and
  `test/properties/` — property-based versions of the four load-bearing invariants — are coming.
- **There is a production application behind it**, where every mutation it makes is a run. The
  engine was extracted from that application rather than designed for a landing page.
- **The same definition goes durable** when a write has to survive a crash, with no rewrite.

Nothing on that list asks you to take a view about anybody's roadmap. Check it or don't buy it.

## Two axes, and neither one is maturity

Every difference on this page comes back to two structural choices. They are worth stating first
because they explain the rest without anybody having to argue about who is more grown up.

**The object of design.** sagaflow models **every mutation**. The platforms model **the occasional
workflow** — the thing worth an instance, a dashboard row and a few hundred milliseconds of
orchestration. Almost everything distinctive here falls out of that single choice:

- a transactional outbox exists because every mutation announces something;
- a tenant sits in every row and every key because every mutation belongs to somebody;
- the inline executor exists because a 3 ms document save cannot afford an instance and still has
  to be undoable and recorded;
- the run record is deliberately short, because something written for every write has to stay
  readable a year later.

**Runtime posture.** A zero-dependency library that runs _inside your request_, on any runtime
including Workers, writing _your_ tables through a journal that a conformance suite holds to its
contract. The alternatives ask for something else, and each of those asks is reasonable in its
own context: a platform that runs the engine, a runtime you build the whole application in, or a
long-lived process that owns recovery.

## The 2×2

Two questions decide most of it: does it need something running, and does it give you saga
semantics or only the primitives to build them.

|                                              | Raw primitives                                     | Full saga semantics                                             |
| -------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| **Runs inline, in the request**              | `try`/`catch` and `queue.send()` — the hand-rolled | **sagaflow**                                                    |
| **Needs a platform or a long-lived process** | Cloudflare Workflows, Vercel Workflow DevKit       | Temporal, Restate, Inngest, Trigger.dev, DBOS, Effect workflows |

The bottom-left cell is empty because nobody sells it, not because nobody writes it — it is what
most teams have. The README draws the same picture as a diagram; this is the version you can
grep.

## The landscape, by category

| Category                          | Who is in it                                    | What it is for                                                               | Where sagaflow differs                                                                                             |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Durable-execution platforms**   | Temporal, Restate, Inngest, Trigger.dev         | Orchestration that outlives processes and deploys, with operations around it | No engine to run and no vendor in the write path; every mutation rather than the notable ones; run records you own |
| **Embedded durable engines**      | DBOS Transact                                   | Durable functions on your own database, no server                            | Every mutation rather than durable functions; an outbox; first-class compensation; any runtime, not a long process |
| **Raw durable primitives**        | Cloudflare Workflows, Vercel Workflow DevKit    | Checkpointing, retries and sleeps provided by the substrate                  | Compensation with a specified order and four outcomes, a run record in your tables, an outbox, and an inline path  |
| **Saga / compensation libraries** | Medusa's workflow SDK, Effect workflows         | Composing multi-step operations that can be undone                           | The body is an ordinary async function, with no DSL and no runtime to adopt; the outbox; the inline path           |
| **Job queues**                    | BullMQ, pg-boss, SQS and a worker               | Moving work off the request and retrying it                                  | A queue moves work; it does not know how to take it back. Ordered undo, atomic outbox, per-tenant idempotency      |
| **Hand-rolled**                   | `try`/`catch` cleanup and a `queue.send()` call | Whatever the last person needed                                              | Exactly the undo order, the trail, the atomic outbox and the dedupe that version was going to grow into anyway     |

## Best at

- **One definition, two executors.** The same saga runs inline in the request or durably on a
  workflow engine. Not two implementations that agree most of the time — one engine with a
  different step runner, so the inline path inherits every property the durable one has.
- **Compensation that is specified rather than implied.** Reverse start order, every undo
  attempted even after one refuses, four distinct outcomes, the whole trail written down, and the
  undo handed exactly what the step returned.
- **A transactional outbox for your own domain events.** Queued in the same atomic write that
  closes the run, so "completed with its audit trail lost" is not a representable state.
- **A run record you own.** Rows in your tables: queryable, joinable against the entities they
  touched, subject to your row-level security, backed up with everything else, and outliving any
  platform's retention window. The diagram of a run is generated from those rows rather than by
  reading your source, so it works for inline runs and on every substrate.
- **Zero runtime dependencies.** Validation is Standard Schema, so the validator is yours; ids
  come from Web Crypto; the sink is Queue-shaped; the journal is SQL.
- **Multi-tenant idempotency.** Keys are per tenant, held by running and completed runs, released
  by the rest — so work that fell over can be asked for again.
- **Tests in milliseconds.** A memory journal and a fake step primitive reproduce a durable
  replay, a retry and a crash with no platform standing up.

## Not best at

Reach for something else when:

- **You need flow control.** No per-tenant concurrency limits, throttling, debouncing or
  scheduling. A Durable Object per key, or your queue consumer's concurrency settings, are the
  right tools and this is the wrong layer.
- **You need signals, queries or child workflows as primitives.** Starting a durable workflow from
  a step and keying it on the parent run id is the documented pattern, not a first-class feature.
- **You need deterministic code replay.** A durable body re-runs from the top; only step results
  are memoised. Non-determinism belongs inside a step, and that is a rule you have to keep rather
  than one the engine keeps for you. Temporal's model is genuinely stronger here.
- **You need exactly-once side effects.** Nobody has these. What is on offer is a stable
  idempotency key per step and an honest description of the rest.
- **You want a UI.** There is no dashboard, no replay button and no alerting. There are rows,
  and `flow.explain(runId)` to render one run as text or a Mermaid diagram — which is enough to
  answer "what happened to this one" and nothing like enough to run an operations team on.
- **You need durability off Cloudflare today.** Durable mode needs a `StepPrimitive`, and
  Cloudflare Workflows is the one that ships. The seam is small — Inngest's `step.run` /
  `step.sleep` / `step.waitForEvent` is the same shape — but small is not the same as written.
- **Your application is built in Effect.** Then its workflows are the right answer and this is the
  wrong one.

## The nearest neighbour: DBOS Transact

DBOS is the closest thing to this posture and a good library. The same instinct drives both:
embed the engine, keep the state in the user's own database, have no server to run. Anyone
weighing sagaflow should weigh DBOS too.

The differences are the two axes and nothing else. DBOS models durable functions and workflows;
sagaflow models every mutation. DBOS wants a long-lived Node process with Postgres; sagaflow is a
library inside a request on any runtime, Workers included. DBOS does not carry an outbox or
first-class compensation.

**What DBOS does better:** an in-process run resumes after a crash with no platform underneath
it. That is a harder problem than anything solved here, and the honest answer for sagaflow today
is a roadmap item rather than a feature — see [what would change this picture](#what-would-change-this-picture).

The side-by-side table is in [`comparison.md`](./comparison.md#the-nearest-neighbour-dbos-transact).

## The principled reference: Effect workflows

Effect's workflow modules are the most carefully designed thing on this list, and worth reading
whether or not you use Effect. Typed errors, resource safety, structured concurrency and retry
policies as values, all the way down and all of a piece.

We are not competing for Effect users, and the structural reason is simple: adopting Effect
workflows means adopting Effect, which is a reasonable decision and a total one. sagaflow assumes
nothing about how your code is written — plain functions, plain promises, whatever validator you
already have. Where their design is better, we say so and where possible we borrow: the typed
error channel beside `output` is on the roadmap because of them.

## Compensation is not the differentiator

It was, once. It is not now, and claiming otherwise would be the kind of marketing that gets
found out on the first read of somebody else's changelog.

Cloudflare Workflows has rollbacks. Vercel's Workflow DevKit has compensations. Effect has
`Workflow.withCompensation`. Medusa has had a compensation function on every step for years.

What differs here is how precisely it is specified — reverse **start** order (because completion
order is not stable across a replay), _every_ undo attempted even after one refuses, four
distinct outcomes instead of one error state, the whole trail written down, and the undo handed
exactly what the step returned rather than captured in a closure that does not survive a replay.
Those are real differences, and every one of them is a paragraph in
[`design.md`](./design.md) explaining what goes wrong otherwise. But "it has compensation" is not
one of them.

## The competitor that actually wins

It is not a platform. It is the `try`/`catch` cleanup block somebody was about to write, and the
`await queue.send()` on the line after the commit.

That version is free, has nothing to learn, and works. It is the right call for a codebase with
three mutations in it. What it does not have is the undo order, the trail, an outbox that is
atomic with the commit, ids that make a repeat recognisable, keys released on failure so failed
work can be retried, and the two sweepers for the failures nothing else notices — a run whose
process died, and a delivery that never landed.

The first version of that takes an afternoon. The sixth takes a year, and by then it is a
framework nobody chose to maintain. That is the trade this library is arguing about, and the
argument is much more interesting than any of the ones above it.

## Who this is for

1. **TypeScript teams on Cloudflare** — Workers, D1, Queues and Workflows — building multi-tenant
   SaaS. This is the flagship: the substrate sagaflow ships an adapter for, and where the whole
   stack is already rows and bindings you own.
2. **Any TypeScript backend** — Hono, tRPC, Next.js server actions, Express, Fastify, Elysia —
   that wants sagas, an outbox and run records without adopting a platform. See
   [`integrations.md`](./integrations.md).
3. **AI-agent backends.** Every agent action becomes a compensating run with a replayable record;
   irreversible actions become proposals that wait for a human. Reads run, writes propose.

## What would change this picture

Stated plainly, because the honest version of "not best at" is a list of things somebody is
working on.

- **Resumable inline runs (0.3)** — a journal-backed `StepPrimitive`: step outputs answered from
  the run record, a cron re-driving abandoned runs, sleeps and waits as due-at rows. That makes
  inline runs survive a crash with no platform underneath, on SQLite, D1 or Postgres. It is the
  first item after 0.1 for a reason: it is the difference between this and a smaller DBOS.
- **A second step primitive** — Inngest first, because its step API is a 1:1 shape match. Two
  adapters is what makes "an engine, not a Cloudflare library" true in code rather than in a
  paragraph.
- **A Postgres dialect** for the SQL journal, tested in process with pglite.

## Further reading

- [`comparison.md`](./comparison.md) — the same landscape, product by product
- [`design.md`](./design.md) — why each part is shaped the way it is
- [`migrating-from-medusa.md`](./migrating-from-medusa.md) — the device map, for one of the
  neighbours above
- [`cheatsheet.md`](./cheatsheet.md) — the whole API on one screen
- `docs/guarantees.md` and `docs/benchmarks.md` — the property-based invariants and the measuring
  methodology, both coming
