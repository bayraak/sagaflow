# Stability and compatibility

## Versioning

Semantic versioning, with the usual pre-1.0 caveat: while the major version is `0`, a **minor**
bump may contain a breaking change and a **patch** never will. The changelog names every one.

## What counts as public

- Everything exported from `sagaflow`, `sagaflow-js/memory`, `sagaflow-js/sql`, `sagaflow/d1`,
  `sagaflow-js/sqlite`, `sagaflow-js/testing` and `sagaflow-js/cloudflare`.
- The reference DDL in `src/sql/schema.sql`, and the default table names.
- The two identity formats: step idempotency keys and envelope ids. These appear in your rows, in
  delivered messages and in other people's idempotency records, so they are a wire format.
- The lifecycle event names and payloads.

Anything reached by a deep import is not public.

## How things change

**New `RunJournal` methods arrive optional.** A method added in a minor version is declared
optional and the engine feature-detects it, so a third-party journal written today keeps
compiling and keeps working. It graduates to required only in a major version, and the
conformance suite says so first.

**`RunStatus` and the lifecycle event union widen only in a major version.** Adding a member to
either breaks exhaustive `switch` statements, which is precisely the code that is doing the right
thing.

**Identity formats never change in a minor version.** Changing one would orphan every row and
every idempotency record already written.

**Anything marked `@experimental` in its JSDoc may change in a minor version.** Nothing carries
that marker in 0.1.0.

## Reserved keys on your context

Your runtime object is spread into every step context, so avoid these names on it — the engine
sets them and would overwrite yours:

`runId` · `emit` · `idempotencyKey` · `attempt`

And these are the runtime's own and are read by the engine: `tenantId`, `actor`, `journal`,
`events`, `eventSchemas`, `observer`.

Everything else is yours. A context carrying `db`, `env`, `logger` or anything else arrives in
every step intact.

## Runtime support

|                    |                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Node               | 20+                                                                                                               |
| Bun                | any current version                                                                                               |
| Deno               | any current version                                                                                               |
| Cloudflare Workers | any current compatibility date                                                                                    |
| TypeScript         | 5.0+ for consumers, checked against 5.9 with `skipLibCheck: false` under both `bundler` and `nodenext` resolution |

ESM only. Relative imports in the published output carry `.js` extensions, so Node's own loader
resolves them without a bundler.

## Dependencies

Zero, in `dependencies`, permanently. `@cloudflare/workers-types` is an optional peer used only
for types by the `d1` and `cloudflare` entry points.

This is a constraint on the design, not a boast: a library that runs inside somebody else's
request has no business adding to their install, their bundle or their audit surface.
