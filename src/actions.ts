import { activeFrame, step, type StepDeclaration, type StepUndo } from './ambient.js'
import { announceResult, type Announce } from './announce.js'
import { assertNameIsAvailable } from './step.js'
import { traced } from './trace.js'

/** How one of a target's methods is undone, given exactly what that method returned. */
export type UndoFor<Method> = Method extends (...args: never[]) => infer Result
  ? StepUndo<Awaited<Result>>
  : never

/**
 * A total map of undos for a set of writes.
 *
 * `satisfies UndoSpec<Writes>` is the point: adding a write to the module fails compilation until
 * somebody has decided how to undo it. `null` is a decision — "this one cannot be taken back" —
 * and it has to be written down rather than reached by omission.
 */
export type UndoSpec<Target> = { [Key in keyof Target]-?: UndoFor<Target[Key]> | null }

type InputOf<Method> = Method extends (first: infer First, ...rest: never[]) => unknown
  ? First
  : never

export type MethodSpec<Method> = StepDeclaration<
  Method extends (...args: never[]) => infer Result ? Awaited<Result> : never
> & {
  /** What the step is recorded as. Defaults to the method's own name. */
  name?: string
  announce?: Announce<
    Method extends (...args: never[]) => infer Result ? Awaited<Result> : never,
    InputOf<Method>
  >
}

export type ActionsSpec<Target> = {
  [Key in keyof Target]?: MethodSpec<Target[Key]> | UndoFor<Target[Key]> | null
} & {
  /**
   * What to do with a method the spec does not list.
   *
   * `memoise-when-durable` (the default) passes it through inline, and inside a DURABLE saga
   * records it as a step with no undo. A durable body runs again from the top on every
   * invocation, so a query answered differently the second time makes the replay diverge —
   * memoising the answer is what keeps the body deterministic.
   *
   * `pass-through` never records it. Correct when the read is already derived from something
   * the run has journalled.
   */
  reads?: 'memoise-when-durable' | 'pass-through'
  /**
   * Report every call through this object to the observer as a span — name, a short rendering of
   * the arguments, how long it took, and whether it threw — with no journal row of its own.
   *
   * The engine journals effects and traces the rest. That is what keeps a run record short
   * enough to read while the whole call tree stays visible to whoever is looking at a trace.
   * Combines with `reads`: a memoised read is both a step and a span.
   */
  trace?: boolean
}

const isMethodSpec = (declared: unknown): declared is MethodSpec<unknown> =>
  typeof declared === 'object' && declared !== null

/**
 * Wrap the door, not every call site.
 *
 * "Every effect is a step" is a rule somebody forgets on a Friday if it has to be remembered at
 * every call site. When effects are reached through one object — a queries module, a service, a
 * binding — wrap the object once and the bodies go back to being plain code: `await
 * seats.reserve(seat)` reads as itself, and is a recorded, retried, undoable step.
 *
 * Listed methods become actions. Unlisted ones pass through, except inside a durable saga where
 * they are memoised as read-steps. Outside a saga, everything passes through and nothing is
 * recorded — which is what makes the wrapped object safe to export as the module.
 */
export const actions = <Target extends object>(
  target: Target,
  spec: ActionsSpec<Target>,
): Target => {
  const wrapped = new Map<PropertyKey, unknown>()
  const reads = spec.reads ?? 'memoise-when-durable'

  return new Proxy(target, {
    get(owner, property, receiver): unknown {
      const value = Reflect.get(owner, property, receiver) as unknown
      if (typeof value !== 'function' || typeof property !== 'string') return value

      const cached = wrapped.get(property)
      if (cached) return cached

      const declared = (spec as Record<string, unknown>)[property]
      const listed = declared !== undefined && property !== 'reads' && property !== 'trace'
      const options: MethodSpec<unknown> = isMethodSpec(declared)
        ? declared
        : typeof declared === 'function'
          ? { undo: declared as StepUndo<unknown> }
          : {}

      const name = options.name ?? property
      if (listed) assertNameIsAvailable(name)

      const work = value.bind(owner) as (...args: unknown[]) => unknown

      const wrapper = async (...args: unknown[]): Promise<unknown> => {
        const frame = activeFrame()

        // Outside a saga this is the method, unchanged. That is the whole reason a wrapped
        // module is safe to export: everything that is not a saga keeps working.
        if (!frame) return work(...args)

        const carry = async <Result>(run: () => Promise<Result>): Promise<Result> =>
          spec.trace === true ? traced(name, args, run) : run()

        if (!listed) {
          return carry(async () => {
            if (reads === 'pass-through' || !frame.durable) return work(...args)

            // A read, memoised, so a replay sees what the first invocation saw.
            return step(name, async () => work(...args))
          })
        }

        return carry(async () =>
          step(
            name,
            async () => {
              const result = await work(...args)
              await announceResult(options.announce as Announce<unknown, unknown>, result, args[0])

              return result
            },
            {
              ...(options.retries === undefined ? {} : { retries: options.retries }),
              ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
              ...(options.undo === undefined || options.undo === null
                ? {}
                : { undo: options.undo as StepUndo<unknown> }),
            },
          ),
        )
      }

      wrapped.set(property, wrapper)

      return wrapper
    },
  })
}
