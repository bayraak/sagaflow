import type { Step, StepContext, StepRetryConfig } from './types'

/**
 * What a step is worth retrying for, when nothing says otherwise. Cloudflare's own default is
 * five attempts over ten minutes; this one is tighter because a step here is one database
 * batch or one provider call, and a run that cannot finish quickly should compensate and say
 * so.
 */
export const defaultStepConfig: StepRetryConfig = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
}

export const createStep = <Ctx, Input, Output, Compensation = never>(
  name: string,
  invoke: (
    input: Input,
    ctx: StepContext<Ctx>,
  ) => Promise<{ output: Output; compensateWith?: Compensation }>,
  compensate?: (compensateWith: Compensation, ctx: StepContext<Ctx>) => Promise<void>,
  config: StepRetryConfig = defaultStepConfig,
): Step<Ctx, Input, Output, Compensation> => ({ name, config, invoke, compensate })

/**
 * One definition, used more than once in one run. A durable engine keys its journal by STEP
 * NAME, so two uses under one name are one step to the platform — the second would be handed
 * the first one's memoised result, and the work it was asked to do would never happen. Every
 * fan-out needs a name per use: one per tenant in a sweep, one per recipient in a digest, one
 * per chunk in an import.
 *
 * A borrowed name, never a taken one: the definition handed in is unchanged and still usable
 * under its own name, because the caller does not own it. A budget may be borrowed with the
 * name — the default is written for a step that talks to somebody else's service, and the
 * same definition inside a fan-out, where the common failure is permanent, should say what it
 * already knows rather than spend a minute per item finding out again.
 */
export const namedStep = <Ctx, Input, Output, Compensation>(
  step: Step<Ctx, Input, Output, Compensation>,
  name: string,
  config?: StepRetryConfig,
): Step<Ctx, Input, Output, Compensation> => ({
  ...step,
  name,
  ...(config === undefined ? {} : { config }),
})
