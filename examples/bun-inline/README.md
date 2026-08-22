# bun-inline

A saga on a plain Bun server. No Cloudflare, no wrangler, no platform of any kind.

```bash
bun install
bun run examples/bun-inline/server.ts
curl -X POST 'http://localhost:3000/bookings?seat=12A'
curl -X POST 'http://localhost:3000/bookings?seat=12A&confirm=false'   # undoes itself
```

Run its tests: `bun run test:examples` from the repository root.

**What to look at**

- `booking.ts` — two `action()`s that bind an undo to an effect, and a saga that calls them like
  ordinary functions.
- The pure check that is not a step: it throws, and the run undoes itself and records why.
- `flow.for({ tenantId, actor })` — one scope per request. The tenant comes from the session.
- The journal is in memory here. Swap it for `createSqliteJournal(new Database('sagas.db'))` and
  the state outlives the process; nothing else changes.
