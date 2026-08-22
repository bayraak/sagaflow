import { requestCancellation } from './cancel.js'
import type { DurableWorkflow, InlineWorkflow } from './define.js'
import { createInProcessSink, createMemoryJournal } from './memory/index.js'
import { startDurableWorkflow } from './start.js'
import type {
  EventSchemaMap,
  InlineRunResult,
  RunJournal,
  RunObserver,
  EventSink,
  StandardSchemaV1,
  TryRunResult,
  WorkflowLauncher,
  WorkflowRuntime,
} from './types.js'

export type SagaflowConfig<Events extends EventSchemaMap = EventSchemaMap> = {
  journal?: RunJournal
  events?: EventSink
  eventSchemas?: Events
  observer?: RunObserver
  /** Where the development-mode warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void
}

/** Everything that can be done on behalf of one tenant. */
export type SagaflowScope<Events extends EventSchemaMap = EventSchemaMap> = {
  run<Input extends StandardSchemaV1, Output>(
    workflow: InlineWorkflow<WorkflowRuntime<Events>, Input, Output>,
    input: StandardSchemaV1.InferInput<Input>,
    options?: { parentRunId?: string | null },
  ): Promise<InlineRunResult<Output>>
  /** The same run, answering instead of throwing. */
  tryRun<Input extends StandardSchemaV1, Output>(
    workflow: InlineWorkflow<WorkflowRuntime<Events>, Input, Output>,
    input: StandardSchemaV1.InferInput<Input>,
    options?: { parentRunId?: string | null },
  ): Promise<TryRunResult<Output>>
  start<Input extends StandardSchemaV1, Output>(
    launcher: WorkflowLauncher,
    workflow: DurableWorkflow<WorkflowRuntime<Events>, Input, Output>,
    input: StandardSchemaV1.InferInput<Input>,
    options?: { parentRunId?: string | null; replayOf?: string },
  ): Promise<{ runId: string; deduplicated: boolean }>
  /** Ask a run to stop. True only if it was running. */
  cancel(runId: string): Promise<boolean>
}

export type Sagaflow<Events extends EventSchemaMap = EventSchemaMap> = {
  for(scope: { tenantId?: string; actor?: string | null }): SagaflowScope<Events>
  /** The runtime object itself, for a body that needs a richer context than the façade offers. */
  runtime(scope: { tenantId?: string; actor?: string | null }): WorkflowRuntime<Events>
}

const developmentWarning =
  'sagaflow is running with no journal, so its state is in memory and not durable. ' +
  'Everything is lost when this process exits and nothing is shared between processes. ' +
  'Pass a journal — sagaflow/d1 or sagaflow/sqlite — before this goes anywhere real.'

/**
 * The assembly, done once.
 *
 * Most callers build the same runtime object on every request, and the assembly is not the
 * interesting part of their code. This is that assembly with a tenant bound to it. The runtime
 * object remains the honest low-level form and is still the right answer for a context that
 * carries a database handle, worker bindings or a logger — `runtime()` hands you one.
 *
 * With no journal at all it runs in memory, delivers events in process, logs what happens, and
 * says once and loudly that nothing is durable. That is so the first five minutes need no
 * infrastructure, and so nobody can mistake it for something to deploy.
 */
export const createSagaflow = <Events extends EventSchemaMap = EventSchemaMap>(
  config: SagaflowConfig<Events> = {},
): Sagaflow<Events> => {
  const ephemeral = config.journal === undefined
  let warned = false

  const warn = (): void => {
    if (warned || !ephemeral) return

    warned = true
    ;(config.warn ?? console.warn)(developmentWarning)
  }

  const journal = config.journal ?? createMemoryJournal().journal
  const events =
    config.events ??
    (ephemeral
      ? createInProcessSink((envelope) => {
          console.info(`[sagaflow] ${envelope.type}`, envelope.payload)
        })
      : undefined)
  const observer =
    config.observer ??
    (ephemeral
      ? {
          onRunEnd: (fact: { name: string; status: string; durationMs: number }): void => {
            console.info(`[sagaflow] ${fact.name} ${fact.status} in ${fact.durationMs}ms`)
          },
        }
      : undefined)

  const runtime = (scope: {
    tenantId?: string
    actor?: string | null
  }): WorkflowRuntime<Events> => ({
    // A single-tenant application should not have to invent a tenant, and a multi-tenant one
    // should never be relying on this.
    tenantId: scope.tenantId ?? 'default',
    actor: scope.actor ?? null,
    journal,
    ...(events === undefined ? {} : { events }),
    ...(config.eventSchemas === undefined ? {} : { eventSchemas: config.eventSchemas }),
    ...(observer === undefined ? {} : { observer }),
  })

  return {
    runtime,
    for: (scope) => {
      const ctx = runtime(scope)

      return {
        run: (workflow, input, options) => {
          warn()

          return workflow.run({ input, ctx, parentRunId: options?.parentRunId ?? null })
        },
        tryRun: (workflow, input, options) => {
          warn()

          return workflow.tryRun({ input, ctx, parentRunId: options?.parentRunId ?? null })
        },
        start: (launcher, workflow, input, options) => {
          warn()

          return startDurableWorkflow({
            launcher,
            definition: workflow,
            input,
            ctx,
            parentRunId: options?.parentRunId ?? null,
            ...(options?.replayOf === undefined ? {} : { replayOf: options.replayOf }),
          })
        },
        cancel: (runId) => requestCancellation({ journal, tenantId: ctx.tenantId, runId }),
      }
    },
  }
}
