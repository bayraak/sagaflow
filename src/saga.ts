import { defineWorkflow, type DurableWorkflow, type InlineWorkflow } from './define.js'
import type { Flow } from './flow.js'
import { anything } from './schema.js'
import type {
  CompensationReason,
  EventEnvelope,
  StandardSchemaV1,
  Step,
  StepBudget,
  StepCall,
  TryRunResult,
  WorkflowRuntime,
} from './types.js'

/** What a step's own function is handed: the scope, plus where it is in the run. */
export type StepRunContext<Extra> = {
  ctx: Extra
  tenantId: string
  actor: string | null
  runId: string
  /** Stable across every attempt and every replay of this step. Hand it to a provider. */
  idempotencyKey: string
  /** Which attempt this is, from one. */
  attempt: number
  emit(type: string, payload: unknown): void
}

/** Everything a step declared inline may say about itself beyond its name and its work. */
export type StepDeclaration<Extra, Output> = StepBudget & {
  undo?(
    output: Output,
    ctx: StepRunContext<Extra>,
    reason: CompensationReason,
  ): Promise<void> | void
}

type Undo<Extra, Output> = (
  output: Output,
  ctx: StepRunContext<Extra>,
  reason: CompensationReason,
) => Promise<void> | void

/**
 * The handle a saga body is given. Conventionally `s`, because it appears on nearly every line
 * of a body and a longer name would be all you see.
 */
export type SagaHandle<Extra = Record<string, unknown>> = {
  /** Whatever `flow.for()` was given beyond the tenant and the actor. */
  ctx: Extra
  runId: string
  /** A step declared where it is used, with its undo as the third argument. */
  step<Output>(
    name: string,
    run: (ctx: StepRunContext<Extra>) => Output | Promise<Output>,
    undo?: Undo<Extra, Output>,
  ): StepCall<Output>
  /** The same, when the step has more to say about itself than its undo. */
  step<Output>(
    name: string,
    run: (ctx: StepRunContext<Extra>) => Output | Promise<Output>,
    options: StepDeclaration<Extra, Output>,
  ): StepCall<Output>
  /** A step declared elsewhere with `step()`, handed its input. */
  step<Input, Output>(
    definition: Step<WorkflowRuntime, Input, Output>,
    input: Input,
  ): StepCall<Output>
  emit(type: string, payload: unknown): void
  /** A named group of steps that run at the same time. */
  all<Results extends readonly unknown[]>(
    name: string,
    members: { [Index in keyof Results]: () => PromiseLike<Results[Index]> },
  ): Promise<Results>
}

/** The handle a durable body is given. Sleeping and waiting exist only here. */
export type DurableSagaHandle<Extra = Record<string, unknown>> = SagaHandle<Extra> & {
  sleep(name: string, duration: string): Promise<void>
  waitForEvent<Payload>(name: string, options: { type: string; timeout?: string }): Promise<Payload>
}

type SharedOptions<Input> = {
  output?: StandardSchemaV1
  /**
   * How this run is recognised as one somebody already asked for. `true` derives the key from
   * the input; a function is there for a key that means something to somebody else.
   */
  idempotent?: true | ((input: Input) => string)
}

export type SagaOptions<Schema extends StandardSchemaV1> = SharedOptions<
  StandardSchemaV1.InferOutput<Schema>
> & {
  input: Schema
  durable?: false
}

export type DurableSagaOptions<Schema extends StandardSchemaV1> = SharedOptions<
  StandardSchemaV1.InferOutput<Schema>
> & {
  input: Schema
  durable: true
}

export type UntypedSagaOptions<Input> = SharedOptions<Input> & {
  input?: undefined
  durable?: false
}

export type UntypedDurableSagaOptions<Input> = SharedOptions<Input> & {
  input?: undefined
  durable: true
}

type Callable<Input, Output> = {
  (input: Input, flow: Flow): Promise<Output>
  /** The same run, answering instead of throwing. */
  try(input: Input, flow: Flow): Promise<TryRunResult<Output>>
  readonly name: string
  readonly input: StandardSchemaV1
}

export type InlineSaga<Input, Output> = Callable<Input, Output> & { readonly durable: false }

export type DurableSaga<Input, Output> = Callable<Input, Output> & {
  readonly durable: true
  /** Hand it to the configured launcher. An instance runs it later. */
  start(input: Input, flow: Flow): Promise<{ runId: string; deduplicated: boolean }>
}

export type AnySaga = DurableSaga<never, unknown> | InlineSaga<never, unknown>

const adapt = <Extra>(handle: {
  step: (...args: never[]) => unknown
  emit: (type: never, payload: never) => void
  all: <Results extends readonly unknown[]>(
    name: string,
    members: { [Index in keyof Results]: () => PromiseLike<Results[Index]> },
  ) => Promise<Results>
}): Pick<SagaHandle<Extra>, 'all' | 'emit' | 'step'> => ({
  all: handle.all,
  emit: (type, payload) => (handle.emit as (t: string, p: unknown) => void)(type, payload),
  step: ((first: unknown, second: unknown, third?: unknown) => {
    if (typeof first !== 'string') {
      return (handle.step as (s: unknown, i: unknown) => unknown)(first, second)
    }

    // `undo` may arrive as the third argument or as a key on it. Both say the same thing, and
    // the shorter one is right far more often than an options object would be.
    const declared =
      typeof third === 'function' ? { undo: third } : ((third ?? {}) as Record<string, unknown>)

    return (handle.step as (n: string, r: unknown, o: unknown) => unknown)(
      first,
      (stepContext: unknown) => Promise.resolve((second as (ctx: unknown) => unknown)(stepContext)),
      declared,
    )
  }) as SagaHandle<Extra>['step'],
})

const runtimeExtras = (runtime: WorkflowRuntime | undefined): unknown =>
  (runtime as { ctx?: unknown } | undefined)?.ctx ?? {}

/**
 * Declare a saga.
 *
 * The name is what the run record, the registry and every durable instance know it by, so it is
 * the one thing that is never optional. Everything else has a sensible answer: inline unless you
 * say `durable: true`, no input schema unless you bring one, no key unless you ask for one.
 *
 * What comes back is callable. `await createBooking(input, flow)` runs it and answers with what
 * the body returned; `.try` answers instead of throwing; `.start` hands it to a launcher, and
 * exists only on a durable definition so that reaching for it on an inline one is a compile
 * error rather than a runtime surprise.
 */
export function saga<Input, Output>(
  name: string,
  body: (input: Input, s: SagaHandle) => Promise<Output>,
): InlineSaga<Input, Output>
export function saga<Schema extends StandardSchemaV1, Output>(
  name: string,
  options: DurableSagaOptions<Schema>,
  body: (input: StandardSchemaV1.InferOutput<Schema>, s: DurableSagaHandle) => Promise<Output>,
): DurableSaga<StandardSchemaV1.InferInput<Schema>, Output>
export function saga<Schema extends StandardSchemaV1, Output>(
  name: string,
  options: SagaOptions<Schema>,
  body: (input: StandardSchemaV1.InferOutput<Schema>, s: SagaHandle) => Promise<Output>,
): InlineSaga<StandardSchemaV1.InferInput<Schema>, Output>
export function saga<Input, Output>(
  name: string,
  options: UntypedDurableSagaOptions<Input>,
  body: (input: Input, s: DurableSagaHandle) => Promise<Output>,
): DurableSaga<Input, Output>
export function saga<Input, Output>(
  name: string,
  options: UntypedSagaOptions<Input>,
  body: (input: Input, s: SagaHandle) => Promise<Output>,
): InlineSaga<Input, Output>
export function saga(
  name: string,
  optionsOrBody: unknown,
  maybeBody?: unknown,
): DurableSaga<unknown, unknown> | InlineSaga<unknown, unknown> {
  const options = (
    typeof optionsOrBody === 'function' ? {} : optionsOrBody
  ) as SharedOptions<unknown> & { input?: StandardSchemaV1; durable?: boolean }
  const body = (typeof optionsOrBody === 'function' ? optionsOrBody : maybeBody) as (
    input: unknown,
    s: never,
  ) => Promise<unknown>

  const input = options.input ?? anything<unknown>()
  const shared = {
    name,
    input,
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.idempotent === undefined
      ? {}
      : { idempotency: options.idempotent as true | ((given: unknown) => string) }),
  }

  const invoke = (parsed: unknown, handle: unknown): Promise<unknown> => {
    const scoped = {
      ...adapt(handle as Parameters<typeof adapt>[0]),
      ctx: runtimeExtras((handle as { runtime?: WorkflowRuntime }).runtime),
      runId: (handle as { runId?: string }).runId ?? '',
      ...(typeof (handle as { sleep?: unknown }).sleep === 'function'
        ? {
            sleep: (handle as { sleep: SagaHandle['step'] }).sleep,
            waitForEvent: (handle as { waitForEvent: SagaHandle['step'] }).waitForEvent,
          }
        : {}),
    }

    return body(parsed, scoped as never)
  }

  if (options.durable === true) {
    const definition = defineWorkflow(
      { ...shared, execution: 'durable' },
      async (parsed: unknown, wf) => invoke(parsed, wf),
    ) as unknown as DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>

    return asDurable(definition, name, input)
  }

  const definition = defineWorkflow(
    { ...shared, execution: 'inline' },
    async (parsed: unknown, wf) => invoke(parsed, wf),
  ) as unknown as InlineWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>

  return asInline(definition, name, input)
}

/** The internal definition behind a callable saga, for the registry and the entrypoint. */
const definitions = new WeakMap<object, unknown>()

export const definitionOf = (
  candidate: object,
): DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown> | undefined =>
  definitions.get(candidate) as
    | DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>
    | undefined

const asInline = <Input, Output>(
  definition: InlineWorkflow<WorkflowRuntime, StandardSchemaV1, Output>,
  name: string,
  input: StandardSchemaV1,
): InlineSaga<Input, Output> => {
  const callable = async (given: Input, flow: Flow): Promise<Output> => {
    flow.announce()
    const answered = await definition.run({ input: given, ctx: flow.runtime })

    return answered.output as Output
  }

  const built = Object.assign(callable, {
    try: (given: Input, flow: Flow): Promise<TryRunResult<Output>> => {
      flow.announce()

      return definition.tryRun({ input: given, ctx: flow.runtime })
    },
    durable: false as const,
    input,
  })
  Object.defineProperty(built, 'name', { value: name })
  definitions.set(built, definition)

  return built as InlineSaga<Input, Output>
}

const asDurable = <Input, Output>(
  definition: DurableWorkflow<WorkflowRuntime, StandardSchemaV1, Output>,
  name: string,
  input: StandardSchemaV1,
): DurableSaga<Input, Output> => {
  const callable = async (_given: Input, _flow: Flow): Promise<Output> => {
    throw new Error(
      `"${name}" is durable, so it is started rather than run: use ${name}.start(input, flow)`,
    )
  }

  const built = Object.assign(callable, {
    try: async (given: Input, flow: Flow): Promise<TryRunResult<Output>> => {
      try {
        return { ok: true, ...(await callable(given, flow)) } as never
      } catch (error) {
        return {
          ok: false,
          runId: null,
          outcome: null,
          failedStep: null,
          compensated: [],
          failedCompensations: [],
          cause: error,
        }
      }
    },
    start: (given: Input, flow: Flow): Promise<{ runId: string; deduplicated: boolean }> =>
      flow.startDurable(definition, given),
    durable: true as const,
    input,
  })
  Object.defineProperty(built, 'name', { value: name })
  definitions.set(built, definition)

  return built as DurableSaga<Input, Output>
}

export type { EventEnvelope }
