import type { Step, StepBackoff, StepContext, StepRetryConfig } from './types.js'

/**
 * What a step is worth retrying for, when nothing says otherwise. Cloudflare's own default is
 * five attempts over ten minutes; this one is tighter because a step here is one database batch
 * or one provider call, and a run that cannot finish quickly should compensate and say so.
 */
export const defaultStepConfig: StepRetryConfig = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
}

/**
 * Names the engine uses for its own steps. A caller's step under one of these would be handed
 * the engine's memoised result on a replay — or would hand the engine its own — so the name is
 * refused at definition time rather than debugged at three in the morning.
 */
export const reservedStepNames = {
  emitEvents: 'emit-events',
  finishRun: 'finish-run',
} as const

export const compensationPrefix = 'compensate:'

/** What the engine calls the step that undoes another one. Declared here, used everywhere. */
export const compensationStepName = (stepName: string): string => `${compensationPrefix}${stepName}`

const assertNameIsAvailable = (name: string): void => {
  if ((Object.values(reservedStepNames) as string[]).includes(name)) {
    throw new Error(`"${name}" is a reserved step name`)
  }

  if (name.startsWith(compensationPrefix)) {
    throw new Error(`a step name may not start with "${compensationPrefix}" — it is reserved`)
  }
}

/** What a step is allowed to spend before it gives up. */
export type StepBudget = {
  retries?: { limit: number; delay: number | string; backoff?: StepBackoff }
  timeout?: number | string
}

/**
 * Everything a step is, apart from its name.
 *
 * An options bag rather than a list of positional arguments, because the next thing anybody
 * wants from a step has to have somewhere to go. A new key here is an additive change; a fifth
 * positional argument would not have been.
 */
export type StepOptions<Ctx, Input, Output, Compensation> = StepBudget & {
  /** The work. Answers with what it produced, and what would undo it. */
  run(
    input: Input,
    ctx: StepContext<Ctx>,
  ): Promise<{ output: Output; compensateWith?: Compensation }>
  /** How to undo it, given exactly what `run` said would undo it. */
  compensate?(compensateWith: Compensation, ctx: StepContext<Ctx>): Promise<void>
}

const budgetOf = (options: StepBudget): StepRetryConfig => {
  if (options.retries === undefined && options.timeout === undefined) return defaultStepConfig

  return {
    ...(options.retries === undefined ? {} : { retries: options.retries }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  }
}

export const createStep = <Ctx, Input, Output, Compensation = never>(
  name: string,
  options: StepOptions<Ctx, Input, Output, Compensation>,
): Step<Ctx, Input, Output, Compensation> => {
  assertNameIsAvailable(name)

  return {
    name,
    config: budgetOf(options),
    run: options.run,
    compensate: options.compensate,
  }
}

/**
 * One definition, used more than once in one run. A durable engine keys its journal by STEP
 * NAME, so two uses under one name are one step to the platform — the second would be handed
 * the first one's memoised result, and the work it was asked to do would never happen. Every
 * fan-out needs a name per use: one per tenant in a sweep, one per recipient in a digest, one
 * per chunk in an import. The engine refuses the duplicate rather than letting it happen
 * quietly, and this is what it is telling you to reach for.
 *
 * A borrowed name, never a taken one: the definition handed in is unchanged and still usable
 * under its own name, because the caller does not own it. A budget may be borrowed with the
 * name — the default is written for a step that talks to somebody else's service, and the same
 * definition inside a fan-out, where the common failure is permanent, should say what it
 * already knows rather than spend a minute per item finding out again.
 */
export const namedStep = <Ctx, Input, Output, Compensation>(
  step: Step<Ctx, Input, Output, Compensation>,
  name: string,
  budget?: StepBudget,
): Step<Ctx, Input, Output, Compensation> => {
  assertNameIsAvailable(name)

  return { ...step, name, ...(budget === undefined ? {} : { config: budgetOf(budget) }) }
}
