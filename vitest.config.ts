import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * The workerd suite.
 *
 * Note on the noise: workerd logs "your Worker's code had hung and would never generate a
 * response" once per Workflows instance the suite creates. It is the local emulator observing
 * that an instance is a background request with no HTTP response to give — it happens with and
 * without sleeps, and every test still passes. It is an emulator artifact, not a leak.
 * The core runs under bun in milliseconds against in-memory adapters; this
 * runs the D1 journal, the step primitive and the entrypoint against the real runtime, real
 * local D1, a real Workflows binding and a real Queue — because an adapter proven against a
 * mock of a platform is proven against the mock.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test-workerd/**/*.spec.ts'],
    // A durable run takes as long as it takes, and this runtime is a real one.
    testTimeout: 30_000,
  },
})
