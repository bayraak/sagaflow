# The landscape, honestly

Checked 2026-08-22. Where something has moved since, the shape of the argument should still hold,
because it is made from structure rather than from anybody's release stage.

## Two structural differences

Everything below comes back to these, and neither is about maturity.

**The object of design.** sagaflow models **every mutation**. The platforms model **the
occasional workflow** — the thing worth an instance, a dashboard row and a few hundred
milliseconds of orchestration. Almost everything distinctive here falls out of that one choice: a
transactional outbox exists because every mutation announces something; a tenant sits in every row
and every key because every mutation belongs to somebody; the inline executor exists because a
3 ms document save cannot afford an instance and still has to be undoable and recorded.

**Runtime posture.** A zero-dependency library that runs _inside your request_, on any runtime
including Workers, writing _your_ tables through a journal a conformance suite holds to its
contract. The alternatives ask for something else: a platform that runs the engine, a runtime bet,
or a long-lived process.

**And compensation is not the differentiator any more.** Cloudflare Workflows has rollbacks.
Vercel's Workflow DevKit has compensations. Effect has `Workflow.withCompensation`. Saying
otherwise would be dishonest. What differs here is how precisely it is specified — reverse start
order, _every_ undo attempted even after one refuses, four distinct outcomes, the whole trail
written down, and the undo handed exactly what the step returned — not that it exists.

## The nearest neighbour: DBOS Transact

Same instinct, and a good library: embed the engine, keep the state in the user's own Postgres, no
server to run.

|                                     | DBOS Transact                        | sagaflow                                                                   |
| ----------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| Models                              | Durable functions and workflows      | Every mutation                                                             |
| Runtime                             | A long-lived Node process            | Any runtime, inside the request; Workers included                          |
| Database                            | Postgres                             | Any store with an atomic multi-statement write; SQLite, D1 and memory ship |
| Compensation                        | Not first-class                      | First-class, with a specified order and four outcomes                      |
| Domain events                       | None                                 | Transactional outbox, written in the closing batch                         |
| Crash recovery of an in-process run | **Yes** — resumes without a platform | No: inline runs are swept to `failed`; durability means a durable executor |

**What DBOS does better:** an in-process run resumes after a crash with no platform underneath it.
That is a genuinely harder problem than anything solved here, and the honest answer for sagaflow
today is a journal-backed `StepPrimitive` on the roadmap rather than a feature.

## Cloudflare Workflows' own rollbacks

The nearest thing in the substrate sagaflow ships an adapter for.

|                        | Cloudflare rollbacks    | sagaflow                                                                                        |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| Where it works         | Durable instances only  | Inline in a request **and** durably                                                             |
| Where the record lives | Their system, 3–30 days | Rows in your database, for as long as you keep them                                             |
| Domain events          | None                    | Transactional outbox                                                                            |
| Deduplication          | Instance-id uniqueness  | Per-tenant keys, held by living runs, released by dead ones                                     |
| Outcome vocabulary     | `Errored`               | `completed` / `compensated` / `failed` / `cancelled`, every undo attempted, both lists recorded |
| Where you can run it   | Cloudflare              | Any runtime; millisecond tests with no platform                                                 |

`terminate({ rollback: true })` runs **Cloudflare's** rollbacks, not sagaflow's undos — it
terminates the instance out from under the engine. Use `flow.cancel(runId)`.

> Cloudflare gave durable workflows an undo. sagaflow gives every mutation a record, an undo, an
> idempotency key and an announcement — whether or not it is a Workflow instance.

## Vercel Workflow DevKit

`"use workflow"` directives, portable "Worlds", a hosted story, and compensations.

**What it does that this does not:** the directive ergonomics are genuinely nicer to read than any
library call; the hosted path is one deploy.

**What this does that it does not:** an inline path with no durability machinery at all; an outbox
for your own domain events; your tables; zero dependencies; no compiler step or directive to
learn — a saga is an async function.

## Effect workflows

`effect/unstable/workflow`, with `Workflow.withCompensation`, a cluster `WorkflowEngine` and SQL
storage. The most principled neighbour on this list, and worth reading whether or not you use it.

**What it does that this does not:** an entire effect system around the workflow — typed errors,
resource safety, structured concurrency, retry policies as values — all the way down. If your
codebase is Effect, its workflows are the right answer and this is the wrong one; we are not
competing for Effect users.

**Where they differ structurally:** `withCompensation` is a scope finalizer, so undos run LIFO at
the top level and nested activities are not themselves compensated; sagaflow's undo chain is
per-step and flat across nested sagas. And Effect's engine wants a long-running process and its
own runtime; this is a library in a request that assumes nothing about yours.

## Temporal, Restate

The reference implementations of durable execution, and the reason most of this vocabulary exists.

**What they do that this does not:** deterministic code replay, signals and queries, child
workflows as primitives, versioning tooling, a UI, and operational maturity at a scale nothing
here has been near.

**What this does that they do not:** run inside the request with no cluster, no server and no
dependencies; model every write rather than the occasional workflow; keep the run record in your
own tables.

If you need a workflow to survive for six months across four deploys with human approvals in the
middle, use Temporal. If you need every `POST /invoices` to be undoable, recorded and announced
once, a cluster is the wrong shape of answer.

## Inngest, Trigger.dev

Hosted platforms with dashboards, flow control, scheduling, and step APIs of the same shape as the
`StepPrimitive` seam here — which is why an Inngest adapter is about twenty lines and on the
roadmap.

**What they do that this does not:** the platform. Concurrency limits, throttling, debouncing,
scheduling, replay from a UI, alerting.

**What this does that they do not:** no vendor in your write path; run records you own; an inline
path that is not a platform call at all.

## Medusa's workflow SDK

Worth its own row because it is the closest thing in the commerce world, and because the contrast
is instructive rather than competitive.

Medusa composes workflows from a step DSL: `createStep`, `createWorkflow`, `transform`, `when`,
`parallelize`, `WorkflowResponse`, with compensation as a second function passed to `createStep`.

```ts
// Medusa
const reserveStep = createStep(
  'reserve',
  async (input: { seat: string }) => new StepResponse(await seats.reserve(input.seat), input.seat),
  async (seat) => {
    await seats.release(seat!)
  },
)

const createBooking = createWorkflow('booking.create', (input: WorkflowData<{ seat: string }>) => {
  const seat = reserveStep(input)
  const charged = chargeStep(transform({ seat }, (data) => ({ amount: data.seat.price })))

  return new WorkflowResponse({ seat, charged })
})
```

```ts
// sagaflow
const createBooking = saga('booking.create', async (input: { seat: string }) => {
  const seat = await step(
    'reserve',
    () => seats.reserve(input.seat),
    (held) => seats.release(held.id),
  )
  const charged = await step('charge', () => cards.charge(seat.price))

  return { seat, charged }
})
```

**What Medusa does that this does not:** a whole commerce framework around it, hooks for plugin
authors, and a long-running engine with its own persistence.

**What this does that it does not:** the body is an ordinary async function, so `if`, `for` and
`await` need no DSL equivalent — there is no `transform`, no `when`, no `parallelize`, because
there is nothing to transform _between_. The compensation receives what the step returned rather
than a second wrapper type. And it runs on Workers, on a 3 ms mutation, with no engine to host.

## A job queue

**What it does that this does not:** fan-out, backpressure, delivery retries, scheduling.

**What this does that it does not:** an ordered undo, an outbox atomic with the mutation,
per-tenant idempotency, and a queryable trail. A queue moves work; it does not know how to take
it back.

## `try`/`catch` and `queue.send()`

The real competitor, and the honest one.

**What it does that this does not:** nothing to learn, nothing to install, no abstraction between
you and the four lines you were going to write.

**What this does that it does not:** the undo order — reverse start, every one attempted; the
trail; the outbox that is atomic with the commit; the deterministic ids that make a repeat
recognisable; the keys released on failure so failed work can be retried; and the sweepers for the
two cases nothing else notices. The first version of that takes an afternoon. The sixth takes a
year.

## What none of them has together

- an inline path that needs no platform **and** a durable one from the same definition
- an outbox for your own domain events, atomic with the run
- zero runtime dependencies
- Cloudflare Workers and D1 **and** any other runtime
- your tables, with the tenant in every row and every key
- a journal conformance suite, so a new store can prove itself rather than be trusted
