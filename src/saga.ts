import {
  activeFrame,
  activeScope,
  all,
  ctx,
  emit,
  runId,
  runInFrame,
  sleep,
  step,
  waitForEvent,
} from './ambient.js'
import { defineWorkflow, type DurableWorkflow, type InlineWorkflow } from './define.js'
import type { Flow } from './flow.js'
import { defaultInstance } from './instance.js'
import { anything, validate } from './schema.js'
import type { StandardSchemaV1, TryRunResult, WorkflowRuntime } from './types.js'

/**
 * The verbs, as methods.
 *
 * The imported verbs are the recommended form and read better; this exists for a body that
 * prefers everything on one object, and for editors that surface members more readily than
 * module exports. They are the same functions.
 */
export type SagaHandle = {
  step: typeof step
  emit: typeof emit
  all: typeof all
  ctx: typeof ctx
  runId: typeof runId
}

export type DurableSagaHandle = SagaHandle & {
  sleep: typeof sleep
  waitForEvent: typeof waitForEvent
}

const handle: DurableSagaHandle = { step, emit, all, ctx, runId, sleep, waitForEvent }

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
> & { input: Schema; durable?: false }

export type DurableSagaOptions<Schema extends StandardSchemaV1> = SharedOptions<
  StandardSchemaV1.InferOutput<Schema>
> & { input: Schema; durable: true }

export type UntypedSagaOptions<Input> = SharedOptions<Input> & {
  input?: undefined
  durable?: false
}

export type UntypedDurableSagaOptions<Input> = SharedOptions<Input> & {
  input?: undefined
  durable: true
}

/** What a caller may say about one particular call. */
export type CallOptions = {
  /** Overrides whatever the definition's `idempotent` rule would have derived. */
  idempotencyKey?: string
  /** The run this one was started from, when a step started it. Provenance only. */
  parentRunId?: string | null
}

type Callable<Input, Output> = {
  (input: Input, flow?: Flow, options?: CallOptions): Promise<Output>
  /** The same run, answering instead of throwing. */
  try(input: Input, flow?: Flow, options?: CallOptions): Promise<TryRunResult<Output>>
  readonly name: string
  readonly input: StandardSchemaV1
}

export type InlineSaga<Input, Output> = Callable<Input, Output> & { readonly durable: false }

export type DurableSaga<Input, Output> = Callable<Input, Output> & {
  readonly durable: true
  /** Hand it to the configured launcher. An instance runs it later. */
  start(
    input: Input,
    flow?: Flow,
    options?: CallOptions,
  ): Promise<{ runId: string; deduplicated: boolean }>
}

export type AnySaga = DurableSaga<never, unknown> | InlineSaga<never, unknown>

const definitions = new WeakMap<object, unknown>()

export const definitionOf = (
  candidate: object,
): DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown> | undefined =>
  definitions.get(candidate) as
    | DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>
    | undefined

/**
 * Which instance a call belongs to: the one it was handed, else the one it is scoped inside,
 * else the in-memory default. Explicit beats ambient, and ambient beats nothing.
 */
const instanceFor = (given: Flow | undefined): Flow =>
  given ?? (activeScope() as Flow | undefined) ?? defaultInstance()

/**
 * Declare a saga.
 *
 * The name is what the run record, the registry and every durable instance know it by, so it is
 * the one thing that is never optional. Everything else has a sensible answer: inline unless you
 * say `durable: true`, no input schema unless you bring one, no key unless you ask for one.
 *
 * What comes back is callable. `await createBooking(input)` runs it and answers with what the
 * body returned; `.try` answers instead of throwing; `.start` hands it to a launcher, and exists
 * only on a durable definition so reaching for it on an inline one is a compile error.
 *
 * Called from inside another saga's body, it does not open a second run: its steps join the
 * caller's trail under its own name, its undos join the caller's chain, and its events are held
 * with the caller's.
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
    s: DurableSagaHandle,
  ) => Promise<unknown>

  const durable = options.durable === true
  const input = options.input ?? anything<unknown>()

  /*
   * The one place the public surface meets the engine's own. `defineWorkflow` overloads on a
   * literal `execution`, which a value computed from `durable` cannot satisfy — so the call is
   * made through its implementation signature here, and the shape it answers with is named
   * below. Every type this erases is re-established by the overloads on `saga` itself.
   */
  const define = defineWorkflow as unknown as (config: unknown, body: unknown) => unknown

  const definition = define(
    {
      name,
      input,
      execution: durable ? 'durable' : 'inline',
      ...(options.output === undefined ? {} : { output: options.output }),
      ...(options.idempotent === undefined
        ? {}
        : { idempotency: options.idempotent as true | ((given: unknown) => string) }),
    },
    async (parsed: unknown, wf: unknown) =>
      runInFrame({ handle: wf as never, prefix: '', durable }, () => body(parsed, handle)),
  ) as DurableWorkflow<WorkflowRuntime, StandardSchemaV1, unknown> &
    Pick<InlineWorkflow<WorkflowRuntime, StandardSchemaV1, unknown>, 'run' | 'tryRun'>

  // A saga inside a saga is not a second run. Its steps join the caller's trail under its own
  // name, so `charge/authorise` reads as what it is, and its undos are part of one chain.
  const nested = async (given: unknown): Promise<unknown> => {
    const frame = activeFrame()
    if (!frame) return undefined

    const parsed = await validate(input, given, `the input of ${name}`)

    return runInFrame({ ...frame, prefix: `${frame.prefix}${name}/` }, () => body(parsed, handle))
  }

  const callable = async (given: unknown, flow?: Flow, call?: CallOptions): Promise<unknown> => {
    if (activeFrame()) return nested(given)

    const target = instanceFor(flow)
    target.announce()

    if (durable) {
      throw new Error(
        `"${name}" is durable, so it is started rather than run: use ${name}.start(input)`,
      )
    }

    const answered = await definition.run({ input: given, ctx: target.runtime, ...call })

    return answered.output
  }

  const built = Object.assign(callable, {
    try: async (
      given: unknown,
      flow?: Flow,
      call?: CallOptions,
    ): Promise<TryRunResult<unknown>> => {
      if (activeFrame() || durable) {
        try {
          return {
            ok: true,
            runId: '',
            output: await callable(given, flow, call),
            deduplicated: false,
          }
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
      }

      const target = instanceFor(flow)
      target.announce()

      return definition.tryRun({ input: given, ctx: target.runtime, ...call })
    },
    ...(durable
      ? {
          start: (
            given: unknown,
            flow?: Flow,
            call?: CallOptions,
          ): Promise<{ runId: string; deduplicated: boolean }> =>
            instanceFor(flow).startDurable(definition, given, call),
        }
      : {}),
    durable,
    input,
  })
  Object.defineProperty(built, 'name', { value: name })
  definitions.set(built, definition)

  return built as DurableSaga<unknown, unknown> | InlineSaga<unknown, unknown>
}
