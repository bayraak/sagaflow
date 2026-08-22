# Examples

Every one of these is executed in CI, not merely type-checked.

| Example                                    | What it shows                                                                                  | Run it                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------- |
| [`bun-inline`](./bun-inline)               | A saga on a plain Bun server. No Cloudflare, no wrangler, no platform.                         | `bun run test:examples`       |
| [`with-valibot`](./with-valibot)           | The same saga validated by Valibot instead of Zod — Standard Schema, no dependency either way. | `bun run test:examples`       |
| [`agent-tools`](./agent-tools)             | MCP-style tools: reads run, writes propose, and the irreversible half waits for a human.       | `bun run test:examples`       |
| [`cloudflare-worker`](./cloudflare-worker) | The copyable template: inline and durable, on Workers, D1, Queues and Workflows.               | `bun run test:example-worker` |

They import `sagaflow` the way you will. In this repository that resolves through a path mapping;
in your project it is a dependency and there is nothing to configure.
