/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare module '*.sql?raw' {
  const contents: string
  export default contents
}
