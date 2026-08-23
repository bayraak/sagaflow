import { runInScope } from './ambient.js'
import { requestCancellation } from './cancel.js'
import type { DurableWorkflow } from './define.js'
import { explainRun, type ExplainFormat } from './explain.js'
import { configureDefault, provideDefaultFactory } from './instance.js'
import { createInProcessSink, createMemoryJournal } from './memory/index.js'
import { definitionOf, type AnySaga } from './saga.js'
import { sizeGuard } from './size-guard.js'
import { startDurableWorkflow, startDurableWorkflows } from './start.js'
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
  /** The same run, arranged so a person can read it. */
  explain(runId: string, options?: { format?: ExplainFormat }): Promise<string>
  /**
   * Say the development-mode warning if it is owed. Called by a definition before it runs; you
   * will not need it.
   */
  announce(): void
  /**
   * Run something with this instance in scope, so a saga called inside it needs no argument.
   * The explicit form still wins where it is given.
   */
  scope<Result>(
    extras: { tenantId?: string; actor?: string | null } & Record<string, unknown>,
    body: () => Promise<Result>,
  ): Promise<Result>
  startDurable(
    definition: DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>,
    input: unknown,
    options?: { replayOf?: string; parentRunId?: string | null; idempotencyKey?: string },
  ): Promise<{ runId: string; deduplicated: boolean }>
  startDurableAll(
    definition: DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>,
    inputs: unknown[],
    options?: { parentRunId?: string | null },
  ): Promise<{ runId: string; deduplicated: boolean }[]>
}

const developmentObserver = (): RunObserver => {
  const trails = new Map<string, string[]>()
  const mark = (runId: string, note: string): void => {
    trails.set(runId, [...(trails.get(runId) ?? []), note])
  }

  const guard = sizeGuard()

  return {
    onStepOutput: guard.onStepOutput,
    onStepEnd: (fact) =>
      mark(fact.runId, `${fact.name} ${fact.status === 'completed' ? '✓' : '✗'}`),
    onCompensationEnd: (fact) =>
      mark(fact.runId, `undo ${fact.name} ${fact.status === 'compensated' ? '✓' : '✗'}`),
    onRunEnd: (fact) => {
      const trail = trails.get(fact.runId) ?? []
      trails.delete(fact.runId)

      console.info(
        `[sagaflow] ${fact.name} · ${fact.runId} · ${fact.status} ${fact.durationMs}ms` +
          (trail.length > 0 ? ` · ${trail.join(' ')}` : '') +
          (fact.events.length > 0
            ? ` · ${fact.events.length} event${fact.events.length === 1 ? '' : 's'} (${fact.events.join(', ')})`
            : ''),
      )
    },
  }
}

/*
 * One line, once, per instance.
 *
 * It has a budget of about two lines before somebody stops reading, and this is the one that
 * matters: what is wrong, what it costs, and what to type instead. A four-line paragraph saying
 * the same thing three ways is read as decoration and skipped, which is the opposite of the
 * point.
 */
const notDurable =
  'sagaflow: in-memory journal — state is lost when the process exits; ' +
  'pass a journal (sagaflow-js/sqlite or sagaflow-js/d1) before production.'

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
export const sagaflow: {
  <Events extends EventSchemaMap = EventSchemaMap>(config?: SagaflowConfig<Events>): Flow<Events>
  configure<Events extends EventSchemaMap = EventSchemaMap>(
    config: SagaflowConfig<Events>,
  ): Flow<Events>
} = <Events extends EventSchemaMap = EventSchemaMap>(
  config: SagaflowConfig<Events> = {},
): Flow<Events> => {
  const ephemeral = config.journal === undefined
  let warned = false

  const journal = config.journal ?? createMemoryJournal().journal
  /*
   * Delivery happens in process so that the quickstart has a whole outbox — events queued in the
   * closing batch, delivered, and marked delivered, so `flow.inspect` shows what a real
   * deployment would show. It prints nothing. What a run emitted belongs on the run's own line,
   * and a payload belongs where somebody went looking for it: `flow.inspect`, `flow.explain`.
   */
  const events = config.events ?? (ephemeral ? createInProcessSink(() => undefined) : undefined)
  // One line per run, and only when nobody brought their own observer. A development log that
  // says what happened in the order it happened beats five that say a fragment each.
  const observer = config.observer ?? (ephemeral ? developmentObserver() : undefined)

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
      /*
       * A layer ADDS what it knows.
       *
       * A worker knows its bindings at module scope and nothing about who is asking; a request
       * knows the tenant and the actor and nothing about bindings; a durable instance gets its
       * env when it is invoked and its tenant from the run it was started for. So `for` is
       * called more than once on the way in, and a `for` that replaced everything would make
       * the last caller responsible for knowing what every earlier one had put there — which is
       * the coupling scoping exists to remove, and which fails silently, because a body sees
       * `undefined` rather than an error.
       */
      for: (next) =>
        build({
          tenantId: next.tenantId ?? runtime.tenantId,
          actor: next.actor === undefined ? runtime.actor : next.actor,
          ...(runtime.ctx as Record<string, unknown>),
          ...next,
        }),
      scope: (scoped, body) => runInScope(flow.for(scoped), body),
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
        if (!declared) throw new Error(`no saga is registered as "${run.name}" to replay`)

        // An inline run has no instance to start. Replaying one would create a durable instance
        // for a definition that was never durable, which is a stranger failure than being told
        // no — run the inline saga again yourself, which is all a replay of one could mean.
        if (declared.durable !== true) {
          throw new Error(`"${run.name}" is not durable, so there is no instance to replay`)
        }

        const definition = definitionOf(declared)
        if (!definition) throw new Error(`no saga is registered as "${run.name}" to replay`)

        return flow.startDurable(definition, run.input, { replayOf: runId })
      },
      cancel: (runId) => requestCancellation({ journal, tenantId: runtime.tenantId, runId }),
      explain: (runId, explainOptions) =>
        explainRun({
          journal,
          tenantId: runtime.tenantId,
          runId,
          ...(explainOptions?.format === undefined ? {} : { format: explainOptions.format }),
        }),
      inspect: async (runId) => {
        const run = await runOf(journal, runtime.tenantId, runId)
        if (!run) return null

        const steps = journal.listRunSteps
          ? await journal.listRunSteps({ tenantId: runtime.tenantId, runId })
          : []

        return { ...run, steps }
      },
      startDurableAll: async (definition, inputs, batchOptions) => {
        announce()
        if (!config.launcher) {
          throw new Error(
            `"${definition.name}" is durable, so starting it needs a launcher: pass one to sagaflow({ launcher })`,
          )
        }

        return startDurableWorkflows({
          launcher: config.launcher,
          definition,
          inputs,
          ctx: runtime,
          parentRunId: batchOptions?.parentRunId ?? null,
        })
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
          parentRunId: options?.parentRunId ?? null,
          ...(options?.replayOf === undefined ? {} : { replayOf: options.replayOf }),
          ...(options?.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: options.idempotencyKey }),
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

// The default instance is an in-memory one, made on first use. It lives here because this module
// is what an instance is; `instance.ts` only holds the reference so the verbs can reach it
// without importing this file back.
provideDefaultFactory(() => sagaflow())

/**
 * Replace the instance a call falls back to when it is given none and is inside no scope.
 * Configure it once, at the top of your process, and every saga you already wrote keeps working.
 */
sagaflow.configure = <Events extends EventSchemaMap = EventSchemaMap>(
  config: SagaflowConfig<Events>,
): Flow<Events> => {
  const instance = sagaflow(config)
  configureDefault(instance as unknown as Flow)

  return instance
}
