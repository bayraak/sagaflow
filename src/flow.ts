import { requestCancellation } from './cancel.js'
import type { DurableWorkflow } from './define.js'
import { createInProcessSink, createMemoryJournal } from './memory/index.js'
import { definitionOf, type AnySaga } from './saga.js'
import { startDurableWorkflow } from './start.js'
import type {
  EventSchemaMap,
  RunJournal,
  RunObserver,
  EventSink,
  StandardSchemaV1,
  WorkflowLauncher,
  WorkflowRuntime,
} from './types.js'

export type SagaflowConfig<Events extends EventSchemaMap = EventSchemaMap> = {
  journal?: RunJournal
  events?: EventSink
  eventSchemas?: Events
  /** The durable binding. Configured once, never handed in per call. */
  launcher?: WorkflowLauncher
  /** The registry. What makes dispatch by name, replay and the Cloudflare entrypoint possible. */
  sagas?: AnySaga[]
  observer?: RunObserver
  /** Where the development-mode warning goes. Defaults to `console.warn`. */
  warn?: (message: string) => void
}

/** A run, as somebody asking after it wants to see it. */
export type RunReport = {
  id: string
  name: string
  execution: string
  status: string
  input: unknown
  output: unknown
  error: string | null
  parentRunId: string | null
  replayOf: string | null
  startedAt: number
  finishedAt: number | null
  steps: { seq: number; name: string; status: string; attempt: number; error: string | null }[]
}

export type Flow<Events extends EventSchemaMap = EventSchemaMap> = {
  /** The low-level runtime object, for anything the instance does not wrap. */
  readonly runtime: WorkflowRuntime<Events>
  readonly config: SagaflowConfig<Events>
  /** The same instance, scoped to a tenant. Extra fields reach every body as `s.ctx`. */
  for(scope: { tenantId?: string; actor?: string | null } & Record<string, unknown>): Flow<Events>
  /** Run a registered saga by the name it was declared under. */
  run(name: string, input: unknown): Promise<unknown>
  /** Start a registered durable saga again, keyed on the run it is replaying. */
  replay(runId: string): Promise<{ runId: string; deduplicated: boolean }>
  cancel(runId: string): Promise<boolean>
  /** The run and its trail, for whoever is asking what happened. */
  inspect(runId: string): Promise<RunReport | null>
  /**
   * Say the development-mode warning if it is owed. Called by a definition before it runs; you
   * will not need it.
   */
  announce(): void
  startDurable(
    definition: DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>,
    input: unknown,
    options?: { replayOf?: string },
  ): Promise<{ runId: string; deduplicated: boolean }>
}

const notDurable =
  'sagaflow is running with no journal, so its state is in memory and not durable. ' +
  'Everything is lost when this process exits and nothing is shared between processes. ' +
  'Pass a journal — sagaflow/d1 or sagaflow/sqlite — before this goes anywhere real.'

/**
 * Configure sagaflow once.
 *
 * Everything a run needs that is not the run itself — where its record goes, where its events
 * go, which launcher starts durable ones, which sagas exist — is here, so a body and a caller
 * can both be about the work.
 *
 * With nothing configured it runs in memory, delivers events in process, logs what happened and
 * says once and loudly that nothing is durable. The first five minutes need no infrastructure,
 * and nobody can mistake it for something to deploy.
 */
export const sagaflow = <Events extends EventSchemaMap = EventSchemaMap>(
  config: SagaflowConfig<Events> = {},
): Flow<Events> => {
  const ephemeral = config.journal === undefined
  let warned = false

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

  const byName = new Map((config.sagas ?? []).map((declared) => [declared.name, declared]))

  const build = (
    scope: {
      tenantId?: string
      actor?: string | null
    } & Record<string, unknown>,
  ): Flow<Events> => {
    const { tenantId, actor, ...extras } = scope

    const runtime = {
      // A single-tenant application should not have to invent a tenant, and a multi-tenant one
      // should never be relying on this.
      tenantId: tenantId ?? 'default',
      actor: actor ?? null,
      journal,
      ctx: extras,
      ...(events === undefined ? {} : { events }),
      ...(config.eventSchemas === undefined ? {} : { eventSchemas: config.eventSchemas }),
      ...(observer === undefined ? {} : { observer }),
    } as WorkflowRuntime<Events>

    const announce = (): void => {
      if (warned || !ephemeral) return

      warned = true
      ;(config.warn ?? console.warn)(notDurable)
    }

    const flow: Flow<Events> = {
      runtime,
      config,
      announce,
      for: (next) => build(next),
      run: async (name, input) => {
        announce()
        const declared = byName.get(name)
        if (!declared) {
          throw new Error(
            `no saga is registered as "${name}" — known: ${[...byName.keys()].join(', ')}`,
          )
        }

        return (declared as unknown as (given: unknown, target: Flow<Events>) => Promise<unknown>)(
          input,
          flow,
        )
      },
      replay: async (runId) => {
        const run = await runOf(journal, runtime.tenantId, runId)
        if (!run) throw new Error(`no run ${runId} to replay`)

        const declared = byName.get(run.name)
        const definition = declared === undefined ? undefined : definitionOf(declared)
        if (!definition) throw new Error(`no durable saga is registered as "${run.name}"`)

        return flow.startDurable(definition, run.input, { replayOf: runId })
      },
      cancel: (runId) => requestCancellation({ journal, tenantId: runtime.tenantId, runId }),
      inspect: async (runId) => {
        const run = await runOf(journal, runtime.tenantId, runId)
        if (!run) return null

        const steps = journal.listRunSteps
          ? await journal.listRunSteps({ tenantId: runtime.tenantId, runId })
          : []

        return { ...run, steps }
      },
      startDurable: async (definition, input, options) => {
        announce()
        if (!config.launcher) {
          throw new Error(
            `"${definition.name}" is durable, so starting it needs a launcher: pass one to sagaflow({ launcher })`,
          )
        }

        return startDurableWorkflow({
          launcher: config.launcher,
          definition,
          input,
          ctx: runtime,
          ...(options?.replayOf === undefined ? {} : { replayOf: options.replayOf }),
        })
      },
    }

    return flow
  }

  return build({})
}

const runOf = async (
  journal: RunJournal,
  tenantId: string,
  runId: string,
): Promise<Omit<RunReport, 'steps'> | null> => {
  if (!journal.getRun) {
    throw new Error(
      'this journal cannot read a run back: implement getRun and listRunSteps to use inspect and replay',
    )
  }

  return journal.getRun({ tenantId, runId })
}
