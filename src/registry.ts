import type { DurableWorkflow } from './define'
import { executeDurable } from './durable'
import { startDurableWorkflow } from './start'
import type { DurableWorkflowEnv, StandardSchemaV1, StepPrimitive, WorkflowRuntime } from './types'

/**
 * A registered workflow is its name and two ways to reach it. Registering erases the
 * definition's own input and output types at the boundary — which is the point: a dispatcher
 * looks a workflow up by a name that arrived as a string, so it cannot know which one it
 * found, and each definition keeps its own types on the inside.
 */
export type RegisteredWorkflow<Ctx extends WorkflowRuntime> = {
  name: string
  execute: (
    params: { runId: string; input: unknown },
    ctx: Ctx,
    step: StepPrimitive,
  ) => Promise<unknown>
  /*
   * Starting one by NAME, which is the only way a replay can start one. Registration is
   * already what makes a definition reachable by the dispatcher; this makes it the same thing
   * that makes it re-runnable, so a workflow can never be replayable without being
   * dispatchable. The input arrives as `unknown` and is parsed by the definition's own schema
   * inside, exactly as it is for a first run.
   */
  start: (
    env: DurableWorkflowEnv,
    options: { input: unknown; ctx: Ctx; replayOf?: string; parentRunId?: string | null },
  ) => Promise<{ runId: string; deduplicated: boolean }>
}

export const registerDurableWorkflow = <
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Output,
>(
  definition: DurableWorkflow<Ctx, Input, Output>,
): RegisteredWorkflow<Ctx> => ({
  name: definition.name,
  execute: (params, ctx, step) => executeDurable(definition, params, ctx, step),
  start: (env, options) => startDurableWorkflow(env, definition, options),
})

export const createDurableRegistry = <Ctx extends WorkflowRuntime>(
  workflows: RegisteredWorkflow<Ctx>[],
) => {
  const byName = new Map(workflows.map((workflow) => [workflow.name, workflow]))

  return {
    names: () => [...byName.keys()],
    find: (name: string) => byName.get(name),
  }
}
