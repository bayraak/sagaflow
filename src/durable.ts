import type { DurableWorkflow } from './define.js'
import { executeRun } from './engine.js'
import { validate } from './schema.js'
import type {
  DurableWorkflowHandle,
  StandardSchemaV1,
  StepPrimitive,
  WorkflowRuntime,
} from './types.js'

/**
 * The same body the inline executor would run, driven through a durable platform's step
 * primitives instead of straight through. The run record was opened by `startDurableWorkflow`
 * before the instance existed, so this only ever writes to it.
 */
export const executeDurable = async <
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Output,
>(
  definition: DurableWorkflow<Ctx, Input, Output>,
  params: { runId: string; input: unknown },
  ctx: Ctx,
  step: StepPrimitive,
): Promise<Output> => {
  const parsed = await validate(definition.input, params.input, `the input of ${definition.name}`)

  return executeRun<Ctx, Output>({
    name: definition.name,
    runId: params.runId,
    ctx,
    runner: (name, config, run) => step.do(name, config, run),
    invoke: (handle) => {
      const durable: DurableWorkflowHandle<Ctx> = {
        ...handle,
        sleep: (name, duration) => step.sleep(name, duration),
        waitForEvent: (name, options) => step.waitForEvent(name, options),
      }

      return definition.body(parsed, durable)
    },
    ...(definition.output === undefined ? {} : { output: definition.output }),
  })
}
