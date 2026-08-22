import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * The workerd suite. The core runs under bun in milliseconds against in-memory adapters; this
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
  },
})
