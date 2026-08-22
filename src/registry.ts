import type { DurableWorkflow } from './define.js'
import { executeDurable } from './durable.js'
import { startDurableWorkflow } from './start.js'
import type {
  DurableWorkflowHandle,
  StandardSchemaV1,
  StepPrimitive,
  WorkflowLauncher,
  WorkflowRuntime,
} from './types.js'

/**
 * A registered workflow is its name and two ways to reach it. Registering erases the
 * definition's own input and output types at the boundary — which is the point: a dispatcher
 * looks a workflow up by a name that arrived as a string, so it cannot know which one it
 * found, and each definition keeps its own types on the inside.
 */
export type RegisteredWorkflow<Ctx extends WorkflowRuntime> = {
  name: string
  execute(
    params: { runId: string; input: unknown },
    ctx: Ctx,
    step: StepPrimitive,
  ): Promise<unknown>
  /*
   * Starting one by NAME, which is the only way a replay can start one. Registration is
   * already what makes a definition reachable by the dispatcher; this makes it the same thing
   * that makes it re-runnable, so a workflow can never be replayable without being
   * dispatchable. The input arrives as `unknown` and is parsed by the definition's own schema
   * inside, exactly as it is for a first run.
   */
  start(options: {
    launcher: WorkflowLauncher
    input: unknown
    ctx: Ctx
    replayOf?: string
    parentRunId?: string | null
  }): Promise<{ runId: string; deduplicated: boolean }>
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
  start: ({ launcher, ...options }) => startDurableWorkflow({ launcher, definition, ...options }),
})

/**
 * Everything a dispatcher can reach, by the name an instance was created with.
 *
 * Hand it the definitions themselves — registering each one is the library's ceremony, not
 * yours. Registration erases a definition's own input and output types at the boundary, which
 * is the point: a dispatcher looks a workflow up by a name that arrived as a string, so it
 * cannot know which one it found, and each definition keeps its types on the inside.
 */
/**
 * A durable definition as the registry needs to see it: erased of its own input and output
 * types, so a list of unrelated definitions holds together. The `never` parameters are what make
 * that erasure assignable — every concrete definition accepts more than `never`, so every
 * concrete definition fits.
 */
export type RegistrableWorkflow<Ctx extends WorkflowRuntime> = {
  name: string
  execution: 'durable'
  input: StandardSchemaV1
  output?: StandardSchemaV1
  idempotency?: true | ((input: never) => string)
  body(input: never, wf: DurableWorkflowHandle<Ctx>): Promise<unknown>
}

export const createDurableRegistry = <Ctx extends WorkflowRuntime>(
  workflows: (RegistrableWorkflow<Ctx> | RegisteredWorkflow<Ctx>)[],
): {
  names: () => string[]
  find: (name: string) => RegisteredWorkflow<Ctx> | undefined
} => {
  const registered = workflows.map((workflow) =>
    // The erasure above is exactly what `registerDurableWorkflow` puts back, so this is the one
    // place the two views of a definition are reconciled.
    'execution' in workflow
      ? registerDurableWorkflow(
          workflow as unknown as DurableWorkflow<Ctx, StandardSchemaV1, unknown>,
        )
      : workflow,
  )
  const byName = new Map(registered.map((workflow) => [workflow.name, workflow]))

  return {
    names: () => [...byName.keys()],
    find: (name: string) => byName.get(name),
  }
}
