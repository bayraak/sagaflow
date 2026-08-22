import path from 'node:path'

import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const packageRoot = path.resolve(import.meta.dirname, '../..')

// The example is executed, not merely type-checked: real workerd, real local D1, a real
// Workflows binding and a real Queue.
//
// The aliases exist only because this example lives inside the package's own repository. In your
// project `@bayraak/sagaflow` is a dependency and there is nothing to alias.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  resolve: {
    alias: {
      '@bayraak/sagaflow/cloudflare': path.join(packageRoot, 'src/cloudflare/index.ts'),
      '@bayraak/sagaflow/memory': path.join(packageRoot, 'src/memory/index.ts'),
      '@bayraak/sagaflow/d1': path.join(packageRoot, 'src/d1/index.ts'),
      '@bayraak/sagaflow': path.join(packageRoot, 'src/index.ts'),
    },
  },
  test: { include: ['test/**/*.spec.ts'], testTimeout: 30_000 },
})
