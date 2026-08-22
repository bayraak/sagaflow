import type { StepPrimitive, StepRetryConfig } from '../../src/index'

export type PrimitiveCall = {
  kind: 'do' | 'sleep' | 'waitForEvent'
  name: string
  config?: StepRetryConfig
  detail?: unknown
}

/**
 * A durable platform reduced to what the engine actually asks of one, so a durable body can
 * be driven without a workflow instance and the suite can see every call it made.
 */
export const createFakePrimitive = (options: { attempt?: number; event?: unknown } = {}) => {
  const calls: PrimitiveCall[] = []

  const primitive: StepPrimitive = {
    do: async (name, config, run) => {
      calls.push({ kind: 'do', name, config })

      return run({ attempt: options.attempt ?? 1 })
    },
    sleep: async (name, duration) => {
      calls.push({ kind: 'sleep', name, detail: duration })
    },
    waitForEvent: async (name, waitOptions) => {
      calls.push({ kind: 'waitForEvent', name, detail: waitOptions })

      return options.event as never
    },
  }

  return { primitive, calls }
}

export const passThroughPrimitive = (): StepPrimitive => ({
  do: async (_name, _config, run) => run({ attempt: 1 }),
  sleep: async () => undefined,
  waitForEvent: async () => undefined as never,
})

/**
 * A platform that retries. The first attempt of every named step is allowed to fail; the
 * second is reported as attempt two, which is how a suite can watch what a step sees when it
 * is tried again.
 */
export const createRetryingPrimitive = (options: { attempts: number }): StepPrimitive => ({
  do: async (_name, _config, run) => {
    let lastError: unknown

    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      try {
        return await run({ attempt })
      } catch (error) {
        lastError = error
      }
    }

    throw lastError
  },
  sleep: async () => undefined,
  waitForEvent: async () => undefined as never,
})
