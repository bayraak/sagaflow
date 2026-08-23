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
 *
 * `workflows` and `registry` may each be given as a function of env, for a host that cannot know
 * what it dispatches to until it has been handed its bindings.
 */
export type DurableRegistry<Ctx extends WorkflowRuntime> = {
  find(name: string): RegisteredWorkflow<Ctx> | undefined
  names(): string[]
}

/** A value, or how to make one out of a worker's env. */
export type FromEnv<Env, Value> = Value | ((env: Env) => Value)

const resolve = <Env, Value>(source: FromEnv<Env, Value>, env: Env): Value =>
  typeof source === 'function' ? (source as (given: Env) => Value)(env) : source

export const createWorkflowEntrypoint = <Env, Ctx extends WorkflowRuntime>(
  options: {
    runtime(env: Env, params: DurableWorkflowParams): Ctx
  } & (
    | {
        workflows: FromEnv<Env, (RegisteredWorkflow<Ctx> | RegistrableWorkflow<Ctx>)[]>
        registry?: never
      }
    | { registry: FromEnv<Env, DurableRegistry<Ctx>>; workflows?: never }
  ),
): WorkflowEntrypointClass<Env> => {
  /*
   * Built once per env and remembered. Cloudflare hands one env object to every invocation of a
   * class in an isolate, so this is once per isolate in practice — and building a registry, and
   * whatever a host's factory builds behind it, on every step boundary is a cost paid for
   * nothing.
   */
  const byEnv = new WeakMap<object, DurableRegistry<Ctx>>()

  const registryFor = (env: Env): DurableRegistry<Ctx> => {
    const build = (): DurableRegistry<Ctx> =>
      options.registry === undefined
        ? createDurableRegistry(resolve(options.workflows, env))
        : resolve(options.registry, env)

    // Hand it the definitions and it builds the registry; hand it a registry and it uses that.
    // A host that dispatches from somewhere else already has one.
    if (env === null || typeof env !== 'object') return build()

    const cached = byEnv.get(env)
    if (cached) return cached

    const registry = build()
    byEnv.set(env, registry)

    return registry
  }

  return class extends WorkflowEntrypoint<Env, DurableWorkflowParams> {
    override async run(
      event: Readonly<WorkflowEvent<DurableWorkflowParams>>,
      step: WorkflowStep,
    ): Promise<unknown> {
      const { name, input, runId } = event.payload
      const registry = registryFor(this.env)
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
 * An instance, or how to build one from a worker's env.
 *
 * Inside a durable instance there is no request. There is `this.env`, handed to the class per
 * invocation, and nothing else — so a host whose scope carries a database handle, its query
 * helpers or any other binding cannot have built that scope where the class was declared. It
 * passes a factory instead, and the entrypoint calls it with the env it was invoked with.
 */
export type FlowSource<Env, Events extends EventSchemaMap> =
  | Flow<Events>
  | ((env: Env) => Flow<Events>)

/** The durable definitions among a flow's sagas. An inline saga has no instance to register. */
const durableDefinitionsOf = <Events extends EventSchemaMap>(
  flow: Flow<Events>,
): RegistrableWorkflow<WorkflowRuntime<Events>>[] =>
  (flow.config.sagas ?? [])
    .map((declared) => definitionOf(declared))
    .filter((definition): definition is NonNullable<typeof definition> => definition !== undefined)
    .map((definition) => definition as unknown as RegistrableWorkflow<WorkflowRuntime<Events>>)

/**
 * The entrypoint class, from an instance or from a factory that builds one out of env.
 *
 * The registry and the runtime both come from the instance, so a worker's whole durable wiring
 * is one line. Cloudflare binds a class rather than a function, and `class_name` in
 * `wrangler.jsonc` points at whatever you export this as.
 *
 * The tenant and the actor are ADDED to whatever scope the instance already carries: they come
 * from the run this instance was started for, the bindings came from env, and the body needs
 * both.
 */
export const entrypointFor = <Env, Events extends EventSchemaMap>(
  source: FlowSource<Env, Events>,
): WorkflowEntrypointClass<Env> => {
  // Once per env — which is once per isolate — rather than once per invocation. A factory
  // builds a journal, a sink and whatever else a host's scope carries, and none of that wants
  // rebuilding every time an instance wakes up.
  const built = new WeakMap<object, Flow<Events>>()

  const flowOf = (env: Env): Flow<Events> => {
    if (typeof source !== 'function') return source
    if (env === null || typeof env !== 'object') return source(env)

    const cached = built.get(env)
    if (cached) return cached

    const flow = source(env)
    built.set(env, flow)

    return flow
  }

  return createWorkflowEntrypoint<Env, WorkflowRuntime<Events>>({
    workflows: (env) => durableDefinitionsOf(flowOf(env)) as never[],
    runtime: (env, params) =>
      flowOf(env).for({ tenantId: params.tenantId, actor: params.actor }).runtime,
  })
}
