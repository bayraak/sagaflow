import { millisecondsOf } from './duration.js'
import type { StepRunner } from './engine.js'
import { defaultStepConfig } from './step.js'
import type { StepRetryConfig } from './types.js'

const delayBefore = (retries: NonNullable<StepRetryConfig['retries']>, attempt: number): number => {
  const base = millisecondsOf(retries.delay)

  if (retries.backoff === 'linear') return base * attempt
  if (retries.backoff === 'exponential') return base * 2 ** (attempt - 1)

  return base
}

/**
 * How the inline executor carries out a step.
 *
 * By default it runs it once. An inline run is holding a request open, and a saga that cannot
 * finish now should compensate and say so rather than spend a budget nobody asked it to.
 *
 * A step that DID ask — one that declares `retries` itself — is believed. A flaky provider call
 * inside a 200 ms mutation is exactly the case where two quick attempts beat compensating the
 * whole saga. Declaring nothing leaves the step at one attempt inline, and at the platform's
 * default when the same definition runs durably.
 *
 * The test for "asked" is identity with `defaultStepConfig`, which is the object `createStep`
 * uses when a caller named neither a retry budget nor a timeout.
 */
export const createInlineRunner = (
  options: { sleep?: (milliseconds: number) => Promise<void> } = {},
): StepRunner => {
  const sleep =
    options.sleep ??
    ((milliseconds: number): Promise<void> =>
      milliseconds <= 0
        ? Promise.resolve()
        : new Promise((resolve) => setTimeout(resolve, milliseconds)))

  return async (_name, config, run) => {
    const retries = config === defaultStepConfig ? undefined : config.retries
    const attempts = (retries?.limit ?? 0) + 1
    let refusal: unknown

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await run({ attempt })
      } catch (error) {
        refusal = error
        if (attempt === attempts || !retries) break

        await sleep(delayBefore(retries, attempt))
      }
    }

    throw refusal
  }
}
