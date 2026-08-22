# cloudflare-worker

The copyable template: inline and durable sagas on Workers, D1, Queues and Workflows.

## Locally, with nothing

```bash
bun install
bun run dev            # wrangler dev, fully local — no account, no credentials
curl -X POST 'http://localhost:8787/bookings?seat=12A'
curl -X POST 'http://localhost:8787/chase?seat=12A'
```

Its tests run against real workerd with local D1, a real Workflows binding and a real Queue:

```bash
bun run test
```

**Local development and the tests need no Cloudflare account and no credentials.**

## Deploying

```bash
./scripts/setup.sh
```

That needs an account, and the Workers **Paid** plan only because of Queues. Authenticate with
`wrangler login`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The script creates
the D1 database (paste the `database_id` it prints into `wrangler.jsonc`), creates the queue,
applies the schema and deploys.

**sagaflow itself needs no secret, no key and no account of any kind.**

## What to look at

- `src/index.ts` — the whole worker: an entrypoint class from `entrypointFor(flow)`, and
  `workerFor(flow, { fetch })` for everything else. Two lines of wiring.
- `src/sagas.ts` — one inline saga and one durable one, from the same `saga()`. The durable one
  sleeps, which is why it is durable.
- `wrangler.jsonc` — every binding, with a note about named environments inheriting nothing.
- `migrations/0001_sagaflow.sql` — sagaflow's three tables and this example's own.
