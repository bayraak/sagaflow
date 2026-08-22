#!/usr/bin/env bash
# Create everything this example needs. Requires `wrangler login`, or CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID in the environment.
#
# Local development and the tests need NONE of this: `bun run dev` works offline.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> creating the D1 database (paste the database_id it prints into wrangler.jsonc)"
wrangler d1 create sagaflow-example

echo "==> creating the queue (Workers Paid plan required for Queues)"
wrangler queues create sagaflow-example-events

echo "==> applying the schema"
wrangler d1 migrations apply sagaflow-example --remote

echo "==> deploying"
wrangler deploy

echo "done. curl -X POST \"\$(wrangler deployments list --json | head -1)/bookings?seat=12A\""
