import { activeFrame, step, type StepDeclaration, type StepUndo } from './ambient.js'
import { announceResult, type Announce } from './announce.js'
import { SagaflowError } from './errors.js'
import { assertNameIsAvailable } from './step.js'

export type ActionOptions<Output, Input> = StepDeclaration<Output> & {
  /** What the step is recorded as. Defaults to the function's own name. */
  name?: string
  /**
   * What this effect announces when it succeeds. Emitted from inside the step, so it is held
   * with the run, memoised with the step — a replay announces exactly once — and dropped
   * entirely if the run is undone.
   */
  announce?: Announce<Output, Input>
}

/**
 * Bind an undo to an effect, once, where the effect is defined.
 *
 * The alternative is repeating the undo at every call site, which is where it goes wrong: the
 * fourth caller forgets, and the run that needed it most is the one that cannot be taken back.
 * Written beside the thing it reverses, it is right everywhere.
 *
 * Called inside a saga, it runs as a step — named, recorded, retried and undone like any other,
 * with `idempotencyKey()` and `attempt()` available inside it. Called anywhere else, it is
 * exactly the function it wraps and nothing is recorded, which is what makes it safe to put on a
 * service that other things also call.
 */
export const action = <Args extends unknown[], Output>(
  work: (...args: Args) => Output | Promise<Output>,
  options: ActionOptions<Output, Args[0]> = {},
): ((...args: Args) => Promise<Output>) => {
  const name = options.name ?? work.name

  if (!name) {
    throw new SagaflowError(
      'action() was given an anonymous function, so it has no name to record it under — ' +
        'name the function, or pass { name }',
    )
  }
  assertNameIsAvailable(name)

  const declared: StepDeclaration<Output> = {
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.undo === undefined ? {} : { undo: options.undo as StepUndo<Output> }),
  }

  return async (...args: Args): Promise<Output> => {
    if (!activeFrame()) return work(...args)

    return step(
      name,
      async () => {
        const result = await work(...args)
        await announceResult(options.announce, result, args[0])

        return result
      },
      declared,
    )
  }
}
