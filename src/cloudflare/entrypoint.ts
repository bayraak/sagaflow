/// <reference types="@cloudflare/workers-types" />

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

import type { Flow } from '../flow.js'
import {
  createDurableRegistry,
  type RegisteredWorkflow,
  type RegistrableWorkflow,
} from '../registry.js'
import { definitionOf } from '../saga.js'
import type { DurableWorkflowParams, EventSchemaMap, WorkflowRuntime } from '../types.js'
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
export const createWorkflowEntrypoint = <Env, Ctx extends WorkflowRuntime>(
  options: {
    runtime(env: Env, params: DurableWorkflowParams): Ctx
  } & (
    | { workflows: (RegisteredWorkflow<Ctx> | RegistrableWorkflow<Ctx>)[]; registry?: never }
    | {
        registry: { find(name: string): RegisteredWorkflow<Ctx> | undefined; names(): string[] }
        workflows?: never
      }
  ),
): WorkflowEntrypointClass<Env> => {
  // Hand it the definitions and it builds the registry; hand it a registry and it uses that.
  // A host that dispatches from somewhere else already has one.
  const registry = options.registry ?? createDurableRegistry(options.workflows)

  return class extends WorkflowEntrypoint<Env, DurableWorkflowParams> {
    override async run(
      event: Readonly<WorkflowEvent<DurableWorkflowParams>>,
      step: WorkflowStep,
    ): Promise<unknown> {
      const { name, input, runId } = event.payload
      const workflow = registry.find(name)

      // A name nothing answers to is a deploy that forgot the registry, and it is worth being
      // loud about: the run record already exists and something has to explain why it stopped.
      if (!workflow) {
        throw new Error(
          `no durable workflow is registered as "${name}" — known: ${registry.names().join(', ')}`,
        )
      }

      return workflow.execute(
        { runId, input },
        options.runtime(this.env, event.payload),
        createStepPrimitive(step),
      )
    }
  }
}

/**
 * The entrypoint class, from an instance.
 *
 * The registry and the runtime both come from the instance, so a worker's whole durable wiring
 * is one line. Cloudflare binds a class rather than a function, and `class_name` in
 * `wrangler.jsonc` points at whatever you export this as.
 */
export const entrypointFor = <Env, Events extends EventSchemaMap>(
  flow: Flow<Events>,
): WorkflowEntrypointClass<Env> =>
  createWorkflowEntrypoint<Env, WorkflowRuntime<Events>>({
    workflows: (flow.config.sagas ?? [])
      .map((declared) => definitionOf(declared))
      .filter(
        (definition): definition is NonNullable<typeof definition> => definition !== undefined,
      )
      .map((definition) => definition as never),
    runtime: (_env, params) => flow.for({ tenantId: params.tenantId, actor: params.actor }).runtime,
  })
