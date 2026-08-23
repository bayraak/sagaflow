import path from 'node:path'

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const packageRoot = path.resolve(import.meta.dirname, '../..')

// The example is executed, not merely type-checked: real workerd, real local D1, a real
// Workflows binding and a real Queue.
//
// The aliases exist only because this example lives inside the package's own repository. In your
// project `sagaflow-js` is a dependency and there is nothing to alias.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  resolve: {
    alias: {
      'sagaflow-js/cloudflare': path.join(packageRoot, 'src/cloudflare/index.ts'),
      'sagaflow-js/memory': path.join(packageRoot, 'src/memory/index.ts'),
      'sagaflow-js/d1': path.join(packageRoot, 'src/d1/index.ts'),
      'sagaflow-js': path.join(packageRoot, 'src/index.ts'),
    },
  },
  test: { include: ['test/**/*.spec.ts'], testTimeout: 30_000 },
})
