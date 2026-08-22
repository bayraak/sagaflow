# Versioning a workflow

The rules here are about **deployed durable workflows**. Inline definitions have no in-flight
state, so none of this applies to them: change them freely.

## The one law

> **Never reshape a deployed durable workflow's steps.** Renaming, reordering, adding one in the
> middle or removing one all break in-flight instances.

A durable platform memoises step results **by name**. When an instance is re-invoked, the body
runs again from the top and each `step()` call is answered from the journal by the name it asks
for. Change the names, or the order they are asked in, and a replaying instance is handed the
wrong result — or none, and re-executes work it already did.

Nothing warns you. The instances that break are the ones that were mid-flight during your deploy,
and they break by doing the wrong thing quietly.

## What to do instead

Version by name and let the old one drain:

```ts
export const sendInvoiceV2 = saga(
  'invoice.send.v2',
  { input: invoiceSendInput, durable: true },
  async (input) => {
    /* the new shape */
  },
)
```

1. Add the new definition under a new name; register both.
2. Point new callers at v2.
3. Wait for v1's in-flight instances to finish. How long depends on the longest `sleep` in the
   body — a workflow that waits thirty days needs thirty days.
4. Delete v1, and its registry entry with it.

`sweepAbandonedRuns` never touches durable runs, so a draining v1 is not swept away underneath
you.

## What is safe to change

| Change                                     | Safe?          | Why                                                                                                                                 |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A step's **body**                          | Yes, with care | Replayed steps do not re-run it, so in-flight instances keep the old result. Make sure the two are interchangeable.                 |
| A step's **retry budget**                  | Yes            | Read at invocation, not memoised.                                                                                                   |
| A step's **compensation**                  | Yes            | Registered from the returned value on every replay, so the current code always runs.                                                |
| Adding a step **at the end**               | Usually        | In-flight instances replay the existing ones and then execute the new one. Safe if it is safe for that instance to do the new work. |
| Renaming a step                            | **No**         | The journal is keyed by it.                                                                                                         |
| Reordering steps                           | **No**         | Same reason.                                                                                                                        |
| Removing or inserting a step in the middle | **No**         | Same reason.                                                                                                                        |
| Changing the input schema                  | Careful        | In-flight instances re-validate the input they were started with. Widening is fine; narrowing rejects them.                         |
| Changing the workflow's **name**           | **No**         | The dispatcher looks instances up by it. That is what versioning by name is.                                                        |

## Why a repeated step name is refused

A definition used twice in one run is one step to the platform, so the second use would be handed
the first use's result and its work would never happen — the digest goes to the first recipient
three times and the other two hear nothing. The engine refuses it on both executors rather than
letting it happen quietly:

```ts
for (const recipient of recipients) {
  await sendDigest(recipient) // send-digest, send-digest#2, send-digest#3 …
}
```

The engine numbers repeated names in **call order**, which is deterministic for a deterministic
body and therefore identical on a replay, so the obvious loop is correct. Where the name is worth
reading in the trail, give each one an explicit name — and derive it from the data, never from a
loop counter over an unordered collection, because a set iterated in a different order would
produce a different journal.

## The names the engine keeps

`finish-run`, `emit-events`, and anything starting `compensate:`. `step()` and `action()` refuse
them at definition time. Two event names are reserved the same way:
`workflow.completed` and `workflow.compensated`.

## Changing the schema of your tables

The three tables are yours; migrate them as you migrate everything else. Two constraints are load
bearing and must survive any migration:

- the **partial** unique index on `(tenant_id, idempotency_key) WHERE status IN ('running','completed')`
- the unique index on `(run_id, seq, attempt)`

Run [`journalConformance`](./adapters.md#proving-a-journal) against the migrated schema. It will
tell you.
