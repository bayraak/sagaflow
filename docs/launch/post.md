# Every mutation is a saga — inline or durable on Cloudflare Workflows

A backend mutation rarely touches one thing. "Save the invoice" is a row, a counter, a file, an
email and an event.

When the **third write fails**, the first two have already happened. When the request is
**retried**, they happen twice. When it **succeeds**, nobody can later say what ran, in which
order, under whose hand. And the event that should announce it is either sent **before** the
commit — lying — or **after** it, and lost on a crash.

Databases solved this inside one store decades ago: transactions, a write-ahead log, unique
constraints, a replication log. The distributed write path of an application has no equivalent.
So we hand-roll `try`/`catch` cleanup, or adopt a durable-execution platform for every write and
pay instance latency and a second system of record for a 5 ms update.

**sagaflow** is an embedded saga engine for TypeScript: workflows that undo themselves, leave a
record, and announce themselves once. Zero runtime dependencies. Your database, your tables, your
process.

## Six lines

```ts
import { emit, saga, step } from 'sagaflow-js'

const createBooking = saga('booking.create', async (input: { seat: string }) => {
  const seat = await step(
    'reserve',
    () => seats.reserve(input.seat),
    (held) => seats.release(held.id),
  )
  await step('charge', () => cards.charge(seat.price))
  await emit('booking.created', { seatId: seat.id })

  return seat
})

await createBooking({ seat: '12A' })
```

That runs with nothing configured — in memory, with one line telling you so. Point it at a
journal and a queue and not one line of the saga changes.

Your workflow is an async function; `if`, `for` and `await` are the DSL. There is no `transform`,
no `when`, no `parallelize` — `Promise.all` already is a parallel group. No compiler step, no
directives, no decorators, no runtime to adopt.

## What it guarantees

Six promises, each with a test you can read:

1. A step's effect is at most **one atomic write**; cross-step consistency is the compensation
   chain — reverse **start** order, every undo attempted, the result recorded as `compensated` or
   `failed`.
2. A run is `completed` **if and only if** its events are durably queued, in one atomic batch.
   "Completed with its audit trail lost" is not a representable state.
3. Events are delivered **at least once** with a **deterministic id**, so a consumer sees each one
   once — and a re-invoked durable body writes its events once.
4. An idempotency key is **held** by running and completed runs and **released** by the rest, per
   tenant. The same work asked twice is answered once; work that fell over can be asked again.
5. Every run ends in exactly one of `completed | compensated | failed | cancelled`. Inline runs
   whose process died are swept; cancellation is cooperative and compensates.
6. Every step has a **stable idempotency key** for the outside world; inputs and outputs are
   validated by **your own** schema library.

The cost is counted rather than described, and asserted exactly: a three-step inline run is five
journal round trips, closing a run is one batch, a re-invocation re-executes nothing.

## The record is a row in your database

Three tables — runs, steps, outbox. Not a dashboard, not a service, not somebody else's retention
window. Query it, join it against the entities it touched, put row-level security on it, back it
up with everything else, and hand it to an agent asking what happened to invoice 4021.

## Cloudflare is the flagship

Durable mode runs on Cloudflare Workflows, and the whole worker is an entrypoint class plus a
handler object: `entrypointFor(flow)` and `workerFor(flow, { fetch })` wire the queue consumer and
both sweepers for you. D1 for the journal, a Queue as the sink, two crons. **Local development and
the entire test suite need no Cloudflare account and no credentials** — the suites run against
real workerd with local D1, Queues and Workflows.

Inline mode runs anywhere: Bun, Node, Deno, any framework, any journal, no infrastructure at all.

## What it is not

Not a durable-execution engine — it rides one. Not a state machine, not a job queue, not a
platform. No flow control. No signals, queries or child workflows as primitives. No deterministic
code replay. No exactly-once side effects, because nobody has those. Durable mode is
Cloudflare-only today, though the step-primitive seam is about twenty lines and Inngest's step API
is the same shape.

And compensation is not the differentiator any more: Cloudflare Workflows has rollbacks, Vercel's
Workflow DevKit has compensations, Effect has `withCompensation`. What differs here is how
precisely it is specified — reverse start order, every undo attempted even after one refuses, four
distinct outcomes, the whole trail written down. DBOS Transact is the nearest neighbour and a good
library; what it does better is resume an in-process run after a crash, which is a harder problem
than anything solved here and the first item on the roadmap.

The thing this actually competes with is not a platform. It is the `try`/`catch` cleanup block you
were about to write, and the `await queue.send()` on the line after the commit. The first version
of that takes an afternoon. The sixth takes a year.

Extracted from a production backend where every mutation is a run. MIT.

**[github.com/bayraak/sagaflow](https://github.com/bayraak/sagaflow)** ·
`bun add sagaflow-js`

---

## Where this goes

Not part of the post. The channel order, the pre-flight gates and who does what are in
[`checklist.md`](./checklist.md); this is the copy for each target.

**Show HN.** Title: `Show HN: Sagaflow – compensating workflows that run inline or durably on
Cloudflare`. URL: `https://github.com/bayraak/sagaflow`. First comment: the post above trimmed to
the problem paragraph, the six lines, the six guarantees and the non-goals, written in the first
person, ending with the honest note that durable mode is Cloudflare-only today and DBOS is the
nearest neighbour.

**Cloudflare Discord, `#workflows`.** Lead with the substrate, not the library: Workflows gives
durability; this adds compensation with a specified order, a run record in your own D1, and a
transactional outbox — plus an inline path for the mutations that do not deserve an instance.
Link [`docs/cloudflare.md`](../cloudflare.md) and
[`examples/cloudflare-worker`](../../examples/cloudflare-worker), which runs locally with no
account.

**r/Cloudflare.** Title: `Sagas on Cloudflare Workflows: compensation, a run record in D1, and a
transactional outbox`. Body: the Cloudflare section of the post, the wrangler bindings and two
crons, and the "why not Cloudflare's own rollbacks" table from the README. Lead with the template
command: `bunx degit bayraak/sagaflow/examples/cloudflare-worker`.

**awesome-cloudflare PR.** One line under the Workers/Workflows libraries section:
`[sagaflow](https://github.com/bayraak/sagaflow) — Embedded saga engine: compensating workflows
inline in a request or durably on Cloudflare Workflows, with a run record and transactional outbox
in your own D1.`

**Hono and tRPC communities.** Not the Cloudflare pitch. Lead with
[`docs/integrations.md`](../integrations.md): one middleware opens a scope per request, and every
mutation in the router becomes a recorded, undoable, idempotent run.

**Medusa / commerce.** Only where migration is genuinely on topic, and always with
[`migrating-from-medusa.md`](../migrating-from-medusa.md) rather than a comparison — the device
map is useful to people who are staying, too.
