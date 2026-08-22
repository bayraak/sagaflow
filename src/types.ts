import type { lifecycleEvents } from './events'

/**
 * The Standard Schema v1 interface, copied inline (MIT, standardschema.dev) so this package
 * depends on no validation library and works with every one that implements the spec — Zod,
 * Valibot, ArkType, Effect Schema. A schema is anything carrying a `~standard` property.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Promise<Result<Output>> | Result<Output>
    readonly types?: Types<Input, Output> | undefined
  }

  export type Result<Output> = FailureResult | SuccessResult<Output>

  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }

  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PathSegment | PropertyKey> | undefined
  }

  export interface PathSegment {
    readonly key: PropertyKey
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input']

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output']
}

export type WorkflowExecution = 'durable' | 'inline'

export type RunStatus = 'cancelled' | 'compensated' | 'completed' | 'failed' | 'running'

/** How a run ended. `running` is the only status that is not an ending. */
export type RunOutcome = Exclude<RunStatus, 'running'>

/**
 * How far the undo got. A run that could not be fully reversed is `failed`, not
 * `compensated` — the difference is the whole point of writing the trail down.
 */
export type CompensationOutcome = Exclude<RunOutcome, 'completed'>

export type StepStatus = 'compensated' | 'completed' | 'failed'

export type StepBackoff = 'constant' | 'exponential' | 'linear'

export type StepRetryConfig = {
  retries?: { limit: number; delay: number | string; backoff?: StepBackoff }
  timeout?: number | string
}

/**
 * The wire shape every event travels in: who it happened to, which run produced it, and when.
 * The payload stays `unknown` here on purpose — the schema for the named type is what decides
 * whether it is well formed.
 */
export type EventEnvelope = {
  id: string
  type: string
  payload: unknown
  tenantId: string
  actor: string | null
  runId: string | null
  occurredAt: number
}

/**
 * Structurally a Cloudflare Queue producer, so a Queue binding IS an EventSink with no
 * adapter at all. Batches only, deliberately: a run emits several events and a sweep delivers
 * many, and one call per message is a round trip per event on the mutation path.
 */
export type EventSink = {
  sendBatch: (messages: { body: EventEnvelope }[]) => Promise<unknown>
}

/**
 * The run record, as the executors need it. Two adapters ship (`sagaflow/memory`,
 * `sagaflow/d1`); nothing above this seam knows a database exists.
 */
export type RunJournal = {
  /**
   * MUST throw when the idempotency key is already HELD — that is, when a run with the same
   * `(tenantId, idempotencyKey)` is `running` or `completed`. The throw IS the dedup signal:
   * the engine answers it by looking the held run up rather than doing the work twice. A run
   * that failed, compensated or was cancelled releases its key, so the work can be asked for
   * again.
   */
  insertRun: (params: {
    tenantId: string
    name: string
    execution: WorkflowExecution
    idempotencyKey: string | null
    input: unknown
    /** The run this one was started to do again, when it is one. Null for nearly every run. */
    replayOf?: string | null
    /**
     * The run this one was started from, when a step started it. Provenance and nothing more:
     * without it a child run is an orphan in the table and nobody can answer "what caused
     * this?". The engine reads no meaning into it, walks no tree and enforces no rule.
     */
    parentRunId?: string | null
  }) => Promise<string>
  /**
   * Idempotent on `(runId, seq, attempt)` — a retried step writes one row, not two.
   *
   * Answers with the run's cancellation flag, in the SAME round trip that writes the step.
   * Cooperative cancellation is then free: the engine already had to talk to the journal here,
   * so noticing that somebody asked the run to stop costs nothing extra.
   */
  recordStep: (params: {
    tenantId: string
    runId: string
    seq: number
    name: string
    status: StepStatus
    attempt: number
    output?: unknown
    error?: string | null
  }) => Promise<{ cancellationRequested: boolean }>
  /**
   * ONE atomic write. Closing the run and writing down the events it emitted are one call
   * because they are one batch underneath: a run is completed if and only if its events are
   * durably queued for delivery. A journal that took them separately could be interrupted
   * between the two, and "completed, audit trail lost" is the state that must not exist.
   */
  finishRun: (params: {
    tenantId: string
    runId: string
    status: RunOutcome
    output?: unknown
    error?: string | null
    events?: EventEnvelope[]
  }) => Promise<void>
  /**
   * Delivered, and recorded as delivered so nothing sweeps it again. Failing this is
   * survivable — the sweeper re-sends, and the consumer recognises the message by its id.
   */
  markEventsDispatched: (params: { tenantId: string; ids: string[] }) => Promise<void>
  /**
   * Raise the cancellation flag on a run. MUST answer true only if the run was `running` —
   * a run that has already ended cannot be stopped.
   */
  requestCancellation: (params: { tenantId: string; runId: string }) => Promise<boolean>
  /**
   * Every tenant's undispatched events, oldest first — the sweeper's query, and the one place
   * in the contract that is deliberately not tenant-scoped, because nobody is asking on a
   * tenant's behalf.
   */
  listUndispatchedEvents: (params: {
    before: number
    limit: number
  }) => Promise<{ tenantId: string; envelope: EventEnvelope }[]>
  /**
   * The runs of the given kind that were started before the cutoff and are still `running`.
   *
   * A list rather than a bulk update, because closing a run is not only a status change: every
   * closed run announces itself, and an announcement needs the run's name and its tenant. The
   * sweeper closes each one through `finishRun`, like everything else that closes a run.
   */
  listAbandonedRuns: (params: {
    execution: 'inline'
    startedBefore: number
    limit: number
  }) => Promise<{ tenantId: string; runId: string; name: string }[]>
  /** Held runs only, by the same rule `insertRun` refuses by. */
  findRunByIdempotencyKey: (params: {
    tenantId: string
    idempotencyKey: string
  }) => Promise<{ id: string; status: RunStatus; output: unknown } | null>
}

export type EventSchemaMap = Record<string, StandardSchemaV1>

/**
 * The names live in events.ts, so this cannot drift from them: a lifecycle event added there
 * has to be given a payload here, and one removed there stops compiling here.
 */
export type LifecycleEventType = (typeof lifecycleEvents)[keyof typeof lifecycleEvents]

/**
 * Facts about the run itself, emitted by the engine and by nothing else. A workflow that tries
 * to emit one is refused. They are declared here so a consumer can switch on them exhaustively
 * beside its own events.
 */
export type LifecycleEventPayloads = {
  [lifecycleEvents.completed]: { runId: string; name: string }
  [lifecycleEvents.compensated]: {
    runId: string
    name: string
    error: string
    outcome: CompensationOutcome
  }
}

/**
 * What every step is handed. `events` is optional because a workflow that emits nothing needs
 * no sink; `eventSchemas` is optional because validation is a choice, and declaring the map
 * is what types `emit` to your own event names.
 */
export type WorkflowRuntime<Events extends EventSchemaMap = EventSchemaMap> = {
  tenantId: string
  actor?: string | null
  journal: RunJournal
  events?: EventSink
  eventSchemas?: Events
}

export type EventsOf<Ctx> = Ctx extends { eventSchemas?: infer Events }
  ? NonNullable<Events> extends EventSchemaMap
    ? NonNullable<Events>
    : EventSchemaMap
  : EventSchemaMap

export type EmitFn<Events extends EventSchemaMap = EventSchemaMap> = <
  Type extends Exclude<keyof Events & string, keyof LifecycleEventPayloads>,
>(
  type: Type,
  payload: StandardSchemaV1.InferInput<Events[Type]>,
) => void

/**
 * What a step is handed. `idempotencyKey` is the step's own — `${runId}:${seq}`, and
 * `${runId}:${seq}:undo` for a compensation — stable across every attempt and every replay of
 * that step, and different for every other step in the run. Hand it to a provider that takes
 * an idempotency header and a retried step stops being a second charge.
 */
export type StepContext<Ctx> = Ctx & {
  runId: string
  emit: EmitFn<EventsOf<Ctx>>
  idempotencyKey: string
}

/**
 * A step, as the engine holds it. `run` and `compensate` are declared as methods rather than
 * function properties so TypeScript checks their parameters bivariantly — which is what lets a
 * heterogeneous list of steps or definitions be held in one array without every caller reaching
 * for a cast.
 */
export type Step<Ctx, Input, Output, Compensation> = {
  name: string
  config: StepRetryConfig
  run(
    input: Input,
    ctx: StepContext<Ctx>,
  ): Promise<{ output: Output; compensateWith?: Compensation }>
  compensate?(compensateWith: Compensation, ctx: StepContext<Ctx>): Promise<void>
}

export type WorkflowHandle<Ctx> = {
  step<Input, Output, Compensation>(
    step: Step<Ctx, Input, Output, Compensation>,
    input: Input,
  ): Promise<Output>
  emit: EmitFn<EventsOf<Ctx>>
}

/**
 * Sleeping and waiting are durable-only capabilities, and this is where that rule lives: an
 * inline body is handed a WorkflowHandle, which has no such members to reach for.
 */
export type DurableWorkflowHandle<Ctx> = WorkflowHandle<Ctx> & {
  sleep: (name: string, duration: string) => Promise<void>
  waitForEvent: <Payload>(
    name: string,
    options: { type: string; timeout?: string },
  ) => Promise<Payload>
}

/**
 * The seam over a durable engine's step primitives. `sagaflow/cloudflare` implements it
 * against a real Cloudflare `WorkflowStep`; a suite implements it against an array of calls.
 * Inngest, Restate and Temporal expose the same three capabilities under other names.
 */
export type StepPrimitive = {
  do: <Output>(
    name: string,
    config: StepRetryConfig,
    run: (ctx: { attempt: number }) => Promise<Output>,
  ) => Promise<Output>
  sleep: (name: string, duration: string) => Promise<void>
  waitForEvent: <Payload>(
    name: string,
    options: { type: string; timeout?: string },
  ) => Promise<Payload>
}

export type InlineRunResult<Output> =
  | { runId: string; output: Output; deduplicated: false }
  | { runId: string; output: unknown; status: RunStatus; deduplicated: true }

/**
 * The event a durable instance is created with. A host types its workflow binding with this,
 * so the dispatcher and the launcher can never disagree about what an instance is started
 * with.
 */
export type DurableWorkflowParams = {
  name: string
  tenantId: string
  actor: string | null
  input: unknown
  runId: string
}

/** Structurally a Cloudflare Workflow binding, narrowed to the one thing a launcher does. */
export type WorkflowLauncher = {
  create: (options: { id?: string; params?: DurableWorkflowParams }) => Promise<{ id: string }>
}

export type DurableWorkflowEnv = { WORKFLOWS: WorkflowLauncher }
