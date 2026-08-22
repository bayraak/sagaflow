/// <reference types="@cloudflare/workers-types" />

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { RegisteredWorkflow } from '../registry.js'
import type { DurableWorkflowParams, WorkflowRuntime } from '../types.js'
import { createStepPrimitive } from './step-primitive.js'

export type WorkflowEntrypointClass<Env> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkflowEntrypoint<Env, DurableWorkflowParams>

/**
 * One entrypoint class for every durable definition you have.
 *
 * Cloudflare binds a CLASS, not a function, so a binding per workflow would mean a wrangler
 * edit and a deploy for every new flow — and four of them, because named environments inherit
 * nothing. This dispatches by the name the instance was created with, so adding a workflow is
 * adding it to the registry and nothing else.
 *
 * `runtime` is where the caller builds a context from the worker's bindings and whatever the
 * instance was started with. It is the caller's because a runtime carries the database handle,
 * the sink and whoever is acting, and this package has no business guessing at any of those.
 */
export const createWorkflowEntrypoint = <Env, Ctx extends WorkflowRuntime>(options: {
  registry: {
    find(name: string): RegisteredWorkflow<Ctx> | undefined
    names(): string[]
  }
  runtime(env: Env, params: DurableWorkflowParams): Ctx
}): WorkflowEntrypointClass<Env> =>
  class extends WorkflowEntrypoint<Env, DurableWorkflowParams> {
    override async run(
      event: Readonly<WorkflowEvent<DurableWorkflowParams>>,
      step: WorkflowStep,
    ): Promise<unknown> {
      const { name, input, runId } = event.payload
      const workflow = options.registry.find(name)

      // A name nothing answers to is a deploy that forgot the registry, and it is worth being
      // loud about: the run record already exists and something has to explain why it stopped.
      if (!workflow) {
        throw new Error(
          `no durable workflow is registered as "${name}" — known: ${options.registry.names().join(', ')}`,
        )
      }

      return workflow.execute(
        { runId, input },
        options.runtime(this.env, event.payload),
        createStepPrimitive(step),
      )
    }
  }
