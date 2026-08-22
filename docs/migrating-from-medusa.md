# From Medusa workflows

For teams who know Medusa's Workflows SDK and are looking at sagaflow — either to move off it, or
to use sagaflow in a service that sits beside a Medusa application.

Medusa's SDK is the closest neighbour in the commerce world and the contrast is instructive
rather than competitive. If you are running Medusa, its workflows are part of the framework, its
hooks are how plugin authors extend your flows, and replacing them is usually the wrong trade.
This page is for the case where you are writing something outside that.

Snippets here are marked `// illustrative`. Medusa's are written against its documented API,
checked 2026-08-22.

## The one difference everything else follows from

**Medusa builds a graph before it runs. sagaflow runs your function.**

A Medusa workflow constructor executes once, at definition time, to record the shape of the
workflow. At that moment step outputs have no values — they are lazy references to values that
will exist later. That is why plain JavaScript cannot be used on them, and why the SDK has to
supply a replacement for each thing JavaScript would have done: `transform` for expressions,
`when().then()` for conditionals, `parallelize` for concurrency.

A sagaflow body is an ordinary `async` function that runs when the saga runs. Values are values.
So most of the device map below is not a translation of one API into another — it is a list of
constructs that have no counterpart because the language already had one.

## The device map

| Medusa                                                      | sagaflow                                                                | Note                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createWorkflow(name, fn)`                                  | `saga(name, body)` / `saga(name, options, body)`                        | The body is `async (input) => value` and runs at run time.                                                                       |
| `new WorkflowResponse(value)`                               | `return value`                                                          | No wrapper type.                                                                                                                 |
| `createStep(name, invoke, compensate)`                      | `action(fn, { undo })` at the effect, or `step(name, run, undo)` inline | Prefer `action`: the undo lives beside the thing it reverses, and outside a saga it is just the function.                        |
| `new StepResponse(output, undoInput)`                       | `return output`                                                         | **One channel.** The undo is handed exactly what the step returned — see below.                                                  |
| `transform({ a, b }, (data) => …)`                          | an expression                                                           | `const total = seat.price + fee`                                                                                                 |
| `when(data, (d) => cond).then(() => …)`                     | `if (cond) { … }`                                                       | Two `when`s for an if/else become one `if`/`else`.                                                                               |
| `parallelize(a(), b())`                                     | `await Promise.all([step(…), step(…)])`                                 | The engine records start order and settles every in-flight step before it unwinds.                                               |
| `step().config({ name: 'other-id' })`                       | nothing — names are numbered automatically                              | Reusing a name gives you `reserve`, `reserve#2`, `reserve#3` in call order. Name them explicitly when the name is worth reading. |
| `otherWorkflow.runAsStep({ input })`                        | `await otherSaga(input)`                                                | Call it. Its steps join the caller's trail under `other.name/step`, one undo chain, one run record.                              |
| `createHook(name, data)` + `WorkflowResponse(v, { hooks })` | typed hooks, 0.2                                                        | See [hooks](#hooks) for what to do today.                                                                                        |
| `workflow.hooks.name(handler, compensate)`                  | 0.2                                                                     | When they land, a handler is a step like any other: its own undo, able to fail the run.                                          |
| `acquireLockStep({ key, timeout, ttl })`                    | `idempotent: true` or `idempotent: (input) => key`                      | A different mechanism for an overlapping problem — see [locking](#locking-and-idempotency).                                      |
| `emitEventStep({ eventName, data })`                        | `await emit(type, payload)`                                             | Held until the run succeeds, then written in the same atomic batch that closes it.                                               |
| `createStep({ name, async: true }, …)` + `setStepSuccess`   | `durable: true` + `await waitForEvent(name, { type })`                  | Medusa can make one step async; sagaflow marks the whole saga durable. See [long-running](#long-running-work).                   |
| `.run({ input })` → `{ result, errors, transaction }`       | `await def(input, flow)` or `await def.try(input, flow)`                | `try` answers `{ ok, value }` / `{ ok: false, error }` instead of an errors array.                                               |
| `transaction.transactionId`                                 | `runId`                                                                 | On the result, on every envelope, and the primary key of a row in your own table.                                                |

## The same saga, side by side

An order that reserves a seat, prices it, renders two documents in parallel and announces itself
if asked to.

```ts
// illustrative — Medusa
const reserveStep = createStep(
  'reserve',
  async (input: { seat: string }) => new StepResponse(await seats.reserve(input.seat), input.seat),
  async (seat) => {
    await seats.release(seat!)
  },
)

const placeOrder = createWorkflow('order.place', (input: WorkflowData<Input>) => {
  const seat = reserveStep(input)
  const amount = transform({ seat }, (data) => data.seat.price + bookingFee)
  const [invoice, receipt] = parallelize(renderInvoiceStep(amount), stampReceiptStep(amount))

  when(input, (data) => data.notify).then(() =>
    emitEventStep({ eventName: 'order.placed', data: { id: input.id } }),
  )

  return new WorkflowResponse({ seat, invoice, receipt })
})
```

```ts
// illustrative — sagaflow
const placeOrder = saga('order.place', async (input: Input) => {
  const seat = await step(
    'reserve',
    () => seats.reserve(input.seat),
    (held) => seats.release(held.id),
  )
  const amount = seat.price + bookingFee
  const [invoice, receipt] = await Promise.all([
    step('invoice', () => render(amount)),
    step('receipt', () => stamp(amount)),
  ])

  if (input.notify) await emit('order.placed', { id: input.id })

  return { seat, invoice, receipt }
})
```

Three of the four SDK constructs are gone because the language does them. The fourth —
compensation — moved from a second wrapper argument to the step's return value.

A shorter version of the same comparison is in
[`comparison.md`](./comparison.md#medusas-workflow-sdk).

## Compensation: one channel instead of two

This is the change that touches every step you port, so it is worth understanding rather than
mechanically applying.

Medusa's step returns `new StepResponse(output, undoInput)`: the first argument goes to the
workflow, the second goes to the compensation function. Two channels.

sagaflow has one. **The undo is handed exactly what the step returned.**

```ts
// illustrative
const reserve = action(seats.reserve, { undo: (held) => seats.release(held.id) })
```

If a step needs something extra in order to undo itself, it returns it — and then its value says
everything about what it did, which is also what the run record holds and what the body was
given. In practice most ports are a simplification: the second argument was usually a subset of
the first.

The reason is not taste. A durable platform answers a completed step from its journal on a replay
without running the body, so anything held in a closure is gone. Returning the undo data means it
is memoised with the output, comes back on every replay and survives serialisation.
[`design.md`](./design.md#why-compensation-is-registered-from-the-return-value) has the long
version.

Porting rule: `new StepResponse(a, b)` becomes `return { …a, …b }` — or just `return a` when `b`
was already part of it — and the compensation's parameter list changes to match.

## Steps used more than once

Medusa asks you to disambiguate by hand: `step().config({ name: 'fetch-customers' })`, because
step ids must be unique within a workflow.

sagaflow numbers them for you. The second use of `reserve` in one run is `reserve#2`, the third is
`reserve#3`, in call order — which is deterministic for a deterministic body and therefore the
same on a replay. Fan-out over a loop needs nothing:

```ts
// illustrative
for (const recipient of recipients) await notify(recipient)
```

Name them explicitly when the name is worth reading in the trail. A name you supply that is
already used in this run is refused, loudly, rather than silently answered with the first one's
memoised result.

## Nested workflows

`runAsStep` becomes a function call.

```ts
// illustrative
const placeOrder = saga('order.place', async (input: Input) => {
  await step('reserve', () => seats.reserve(input.seat))

  return chargeCard({ amount: 4200 })
})
```

The trail reads `reserve`, `charge/authorise`, `charge/capture`. One run, one compensation chain,
one record, and the child's events held with the parent's. Called from outside a saga, `chargeCard`
runs on its own as usual. There is no API for this because it needed none.

The difference worth knowing: Medusa's nested workflow is a step in the parent's transaction;
sagaflow's is flattened into the parent's run. You get one record instead of two, and the child's
undos are interleaved into the parent's chain in start order rather than run as a unit.

## Events

`emitEventStep` publishes through Medusa's event bus as a step in the workflow.

`await emit(type, payload)` in a sagaflow body or step does something structurally different, and
it is the main thing sagaflow has that Medusa does not:

- Emissions are **held** until the run succeeds. A run that was undone announces nothing it did,
  because it did not do it.
- They are written into your outbox table **in the same atomic write that closes the run**. There
  is no window in which the run is committed and the announcement is lost.
- Delivery is at-least-once afterwards, with a deterministic envelope id (`${runId}:${ordinal}`)
  so a consumer can recognise a repeat.
- A run that was undone writes exactly one event, `workflow.compensated`, because an audit log and
  an operator both want to know that.

Declare `eventSchemas` on the instance and `emit` is typed to your own event names and validated
against your own schemas.

## Locking and idempotency

`acquireLockStep({ key, timeout, ttl })` takes a lock so two concurrent workflows do not touch the
same entity at once. sagaflow has no lock step, and the honest answer has two halves.

For **"the same work must not happen twice"**, use the idempotency key, which is the better tool
for that job: `idempotent: true` derives it from the input, or pass a function when the key means
something to somebody else. The key is held by runs that are running or completed and released by
runs that failed, compensated or were cancelled — so a duplicate request is answered with the
first run's result, and work that fell over can be asked for again. Keys are per tenant. This is
enforced by a partial unique index in your database rather than by a lock service.

For **"two different operations must not interleave on one row"**, sagaflow has nothing and says
so. There is no isolation between concurrent sagas beyond what your own steps enforce; two runs
touching the same row race exactly as two requests would. Use your database's constraints and
locks, or a Durable Object per key. The saga literature calls the alternatives countermeasures —
semantic lock, commutative updates, reread value — and helpers for them are a roadmap item, not a
feature.

## Long-running work

Medusa turns a workflow long-running by marking one step `async: true`; the step returns nothing,
the workflow pauses there, and something later calls `setStepSuccess` or `setStepFailure` with the
transaction id. You subscribe to the workflow engine to hear about completion.

sagaflow decides this per saga, not per step. `durable: true` moves the whole definition onto a
workflow engine, and then the body can `sleep` and `waitForEvent`:

```ts
// illustrative
const settleRefund = saga('refund.settle', { input: refundInput, durable: true }, async (input) => {
  const decision = await waitForEvent<{ approved: boolean }>('approval', {
    type: 'refund.approved',
    timeout: '7 days',
  })

  if (!decision.approved) return { settled: false }

  await step('pay', () => payments.refund(input.chargeId))

  return { settled: true }
})

await settleRefund.start(input, flow)
```

A durable definition has `.start()` and no useful call signature, and only a durable body may
sleep or wait — that is a compile error, not a convention. Waking it is
`sendWorkflowEvent({ binding, name, runId, event })` from `@bayraak/sagaflow/cloudflare`, which
derives the instance id the same way the launcher did, so an approval endpoint never hand-builds
one.

Instead of subscribing to an engine, you read your own tables: `flow.inspect(runId)` for the run
and its trail as data, `flow.explain(runId)` for the same thing rendered for a person as text or a
Mermaid diagram, or the `workflow.completed` / `workflow.compensated` events out of the outbox.

For fan-out — one durable run per recipient, per tenant, per chunk — `def.startAll(inputs, flow)`
opens every run record and starts them in as few platform calls as the launcher allows.

**Today this needs Cloudflare Workflows.** That is the substrate the shipped `StepPrimitive`
targets. Inline sagas run anywhere.

## Hooks

Medusa's `createHook` is a named extension point that a **different module** — a plugin, another
team's code — registers a handler on, with its own compensation. It is one of the genuinely good
parts of the SDK and sagaflow does not have it yet.

It is planned for 0.2, and it will be steps: a handler with its own undo, able to fail the run,
undone with it. Nothing weaker would be honest, because a hook that cannot fail the run is a hook
that lets a half-applied mutation through.

Until then: if you own the saga, a hook is a function call with machinery around it — call the
function. If you need third-party extension points today, that is a real reason to stay where you
are.

## Porting, in order

1. **Steps first, as `action`s.** Take each `createStep` and rewrite it as `action(fn, { undo })`
   beside the function it wraps. Collapse the `StepResponse` pair into one return value. At this
   point nothing calls them yet and the old workflow still runs.
2. **If effects arrive through one module** — a service, a queries object — wrap the module once
   with `actions(module, spec)` instead of writing an action per function. `satisfies
UndoSpec<…>` then makes it a compile error to add a write without deciding how to undo it.
3. **Then the bodies.** `createWorkflow` becomes `saga`, `transform` becomes an expression, `when`
   becomes `if`, `parallelize` becomes `Promise.all`, `runAsStep` becomes a call, and
   `WorkflowResponse` disappears.
4. **Choose the executor.** Inline unless it sleeps, waits, fans out, touches the outside world,
   takes more than roughly a second or must survive a crash.
5. **Move the schema.** Three tables: `bunx sagaflow schema > migrations/0001_sagaflow.sql`,
   through your own migration tool. See [`integrations.md`](./integrations.md#the-ddl).
6. **Wire the scope.** One `flow.for(...)` or `flow.scope(...)` per request; the tenant comes from
   the session, never from input.
7. **Then the events**, last, because this is the part with no counterpart: what was
   `emitEventStep` becomes `emit`, and you gain an outbox you now have to drain — a queue consumer
   and a `sweepEventOutbox` cron, or an in-process sink.

Test as you go by calling the saga. A memory journal and no platform is milliseconds per case.

## What Medusa still does better

Stated plainly, because a migration page that only lists wins is a sales page.

- **Hooks for plugin authors.** A first-class, typed extension point with its own compensation,
  that another module can register against without the workflow knowing it exists. sagaflow: 0.2.
- **Async steps anywhere.** Medusa can suspend one step of an otherwise ordinary workflow and have
  something else resolve it later. sagaflow's equivalent is marking the whole saga durable, which
  is a coarser instrument and needs a workflow engine underneath.
- **The framework around it.** A workflow engine module with its own persistence, subscriptions to
  execution status, admin visibility, and a large library of core flows you can compose or extend.
  If you are building commerce on Medusa, none of that is replaceable by a library.
- **Maturity in its domain.** Its workflows run a great deal of real commerce, with the operational
  knowledge that comes from that.

## What you gain

- The body is an ordinary async function, so there is no DSL to learn and no lazy-reference model
  to reason about.
- A transactional outbox: events atomic with the run, held until it succeeds, deduplicated by a
  deterministic id.
- A run record in **your** tables — queryable, joinable, subject to your row-level security, and
  outliving anybody's retention window.
- An inline executor, so a 3 ms mutation can be a saga without an engine hosting it.
- Multi-tenant idempotency, held and released by run status.
- Zero runtime dependencies, on any runtime including Cloudflare Workers.
- Tests in milliseconds, with no engine to stand up.

## Further reading

- [`positioning.md`](./positioning.md) — where this sits, and when to use something else
- [`comparison.md`](./comparison.md) — the honest landscape, product by product
- [`design.md`](./design.md) — why compensation, ordering and the outbox are shaped this way
- [`cheatsheet.md`](./cheatsheet.md) — the whole sagaflow API on one screen, for the port itself
- [`SKILL.md`](../SKILL.md) — for coding agents doing the port with you
