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

/**
 * What a durable platform actually does on re-invocation: the body runs again from the top,
 * and every step it reaches that has already completed is answered from the journal instead of
 * being executed. The clone is not decoration — a real journal round-trips the value through
 * serialisation, and anything the engine expects to get back has to survive that.
 */
export const createCachingPrimitive = (options: { neverCache?: string[] } = {}) => {
  const cache = new Map<string, unknown>()
  const calls: string[] = []
  const executed: string[] = []

  const primitive = (): StepPrimitive => ({
    do: async (name, _config, run) => {
      calls.push(name)
      if (cache.has(name)) return cache.get(name) as never

      executed.push(name)
      const output = await run({ attempt: 1 })
      // A step the platform never got to record — the isolate died between doing the work and
      // checkpointing it — is a step the next invocation runs again. Naming those here is how
      // a suite reproduces the crash window that matters.
      if (!options.neverCache?.includes(name)) cache.set(name, structuredClone(output))

      return output
    },
    sleep: async () => undefined,
    waitForEvent: async () => undefined as never,
  })

  return { primitive, calls, executed }
}
