import type { RunObserver } from './types.js'

/**
 * What a durable platform will accept as one step's output. Cloudflare's limit, and a good
 * instinct everywhere: a step returns a receipt, not the thing it fetched.
 */
export const stepOutputLimit = 1_048_576

const mebibyte = 1_048_576

const readable = (bytes: number): string =>
  bytes >= mebibyte ? `${(bytes / mebibyte).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`

/**
 * Warn about a step whose output is too big for a durable platform to checkpoint.
 *
 * Cloudflare refuses an output over a mebibyte at runtime, in production, on the run that
 * finally had a large enough import to trip it — which is a bad place to learn it. This is the
 * warning instead, and it is an observer rather than a rule in the engine so that measuring
 * costs a serialisation per step only for the people who asked to be told.
 *
 * Install it in development. In production, either keep it and accept the cost, or leave it out
 * and rely on the habit it taught you.
 */
export const sizeGuard = (
  options: { limit?: number; warn?: (message: string) => void } = {},
): RunObserver => {
  const limit = options.limit ?? stepOutputLimit
  const warn = options.warn ?? console.warn

  return {
    onStepOutput: (fact) => {
      if (fact.bytes <= limit) return

      warn(
        `sagaflow: step "${fact.name}" returned ${readable(fact.bytes)}, over the ${readable(limit)} a durable platform will checkpoint. ` +
          'Return a receipt and put the bytes in object storage.',
      )
    },
  }
}
