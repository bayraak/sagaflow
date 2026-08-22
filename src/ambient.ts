import { AsyncLocalStorage } from 'node:async_hooks'

import { SagaflowError } from './errors.js'
import type {
  CompensationReason,
  StepBudget,
  StepContext,
  WorkflowHandle,
  WorkflowRuntime,
} from './types.js'

/**
 * What a step's own function is handed: where it is in the run, and the scope the caller set.
 */
export type StepRunContext<Extra = Record<string, unknown>> = {
  runId: string
  /** Stable across every attempt and every replay of this step. Hand it to a provider. */
  idempotencyKey: string
  /** Which attempt this is, from one. */
  attempt: number
  tenantId: string
  actor: string | null
  ctx: Extra
}

export type StepUndo<Output, Extra = Record<string, unknown>> = (
  output: Output,
  ctx: StepRunContext<Extra>,
  reason: CompensationReason,
) => Promise<void> | void

export type StepDeclaration<Output, Extra = Record<string, unknown>> = StepBudget & {
  undo?: StepUndo<Output, Extra>
}

type Frame = {
  handle: WorkflowHandle<WorkflowRuntime>
  /** What a nested saga's steps are named under. Empty at the top of a run. */
  prefix: string
  durable: boolean
  /** Set while a step's own function — or its undo — is running. */
  step?: StepRunContext
}

/*
 * Where "which saga am I in" lives.
 *
 * AsyncLocalStorage is the only thing that answers that question correctly when two runs are in
 * flight at once, which in a server is always. It needs Node 16+, Bun, Deno, or a Cloudflare
 * Worker with `nodejs_compat` — which is the same requirement the Workers runtime already puts
 * on most libraries, and the reason this import is at the top rather than hidden behind a
 * fallback that would be quietly wrong under concurrency.
 */
const frames = new AsyncLocalStorage<Frame>()

export const runInFrame = <Result>(frame: Frame, body: () => Promise<Result>): Promise<Result> =>
  frames.run(frame, body)

export const activeFrame = (): Frame | undefined => frames.getStore()

const inside = (verb: string): Frame => {
  const frame = frames.getStore()
  if (!frame) {
    throw new SagaflowError(
      `${verb}() was called outside a saga — it only works inside the body of one`,
    )
  }

  return frame
}

const contextOf = (stepContext: unknown): StepRunContext => {
  const given = stepContext as StepContext<WorkflowRuntime> & { ctx?: unknown }

  return {
    runId: given.runId,
    idempotencyKey: given.idempotencyKey,
    attempt: given.attempt,
    tenantId: given.tenantId,
    actor: given.actor ?? null,
    ctx: (given.ctx ?? {}) as Record<string, unknown>,
  }
}

/**
 * Do a unit of work, and say how to undo it.
 *
 * The name is what the run record and a durable platform's journal know the step by, so it has
 * to be stable and unique within the run. Pass a named function and the function's name is used.
 */
export function step<Output>(
  name: string,
  run: (ctx: StepRunContext) => Output | Promise<Output>,
  undo?: StepUndo<Output>,
): Promise<Output>
export function step<Output>(
  name: string,
  run: (ctx: StepRunContext) => Output | Promise<Output>,
  options: StepDeclaration<Output>,
): Promise<Output>
export function step<Output>(
  run: (ctx: StepRunContext) => Output | Promise<Output>,
  undo?: StepUndo<Output>,
): Promise<Output>
export function step(first: unknown, second?: unknown, third?: unknown): Promise<unknown> {
  const frame = inside('step')

  const named = typeof first === 'string'
  const name = named ? (first as string) : ((first as { name?: string }).name ?? '')
  const run = (named ? second : first) as (ctx: unknown) => unknown
  const declared = named ? third : second

  if (!named && name === '') {
    throw new SagaflowError(
      'step() was given an anonymous function, so it has no name to record it under — ' +
        'name the function, or call step(name, fn)',
    )
  }

  const options =
    typeof declared === 'function'
      ? { undo: declared as StepUndo<unknown> }
      : ((declared ?? {}) as StepDeclaration<unknown>)

  const declaredUndo = options.undo

  return Promise.resolve(
    frame.handle.step(
      `${frame.prefix}${name}`,
      async (stepContext) => {
        const scoped = contextOf(stepContext)

        return runInFrame({ ...frame, step: scoped }, async () => run(scoped))
      },
      {
        ...(options.retries === undefined ? {} : { retries: options.retries }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(declaredUndo === undefined
          ? {}
          : {
              undo: async (
                output: unknown,
                stepContext: StepContext<WorkflowRuntime>,
                reason: CompensationReason,
              ): Promise<void> => {
                const scoped = contextOf(stepContext)

                await runInFrame({ ...frame, step: scoped }, async () => {
                  await declaredUndo(output, scoped, reason)
                })
              },
            }),
      },
    ),
  )
}

/**
 * Announce something the run did. Held until the run succeeds, written down in the same batch
 * that closes it, delivered afterwards. Awaited like every other verb, though it has nothing to
 * wait for — one rule, no exceptions to remember.
 */
export const emit = async (type: string, payload: unknown): Promise<void> => {
  ;(inside('emit').handle.emit as (t: string, p: unknown) => void)(type, payload)
}

const durableOnly = (verb: string, frame: Frame): void => {
  if (frame.durable) return

  throw new SagaflowError(
    `${verb}() only works in a durable saga — declare it with { durable: true }`,
  )
}

/** Wait, durably. The instance stops existing and comes back; nothing is held open. */
export const sleep = async (name: string, duration: string): Promise<void> => {
  const frame = inside('sleep')
  durableOnly('sleep', frame)

  await (frame.handle as unknown as { sleep(n: string, d: string): Promise<void> }).sleep(
    `${frame.prefix}${name}`,
    duration,
  )
}

/** Wait for something from outside, durably. */
export const waitForEvent = <Payload>(
  name: string,
  options: { type: string; timeout?: string },
): Promise<Payload> => {
  const frame = inside('waitForEvent')
  durableOnly('waitForEvent', frame)

  return (
    frame.handle as unknown as {
      waitForEvent<T>(n: string, o: { type: string; timeout?: string }): Promise<T>
    }
  ).waitForEvent<Payload>(`${frame.prefix}${name}`, options)
}

/** The tenant, the actor, and whatever else the caller scoped this request with. */
export const ctx = <Extra = Record<string, unknown>>(): Extra & {
  tenantId: string
  actor: string | null
} => {
  const runtime = inside('ctx').handle.runtime as WorkflowRuntime & {
    ctx?: Record<string, unknown>
  }

  return {
    ...runtime.ctx,
    tenantId: runtime.tenantId,
    actor: runtime.actor ?? null,
  } as Extra & { tenantId: string; actor: string | null }
}

/** The id of the run this body is part of. */
export const runId = (): string => inside('runId').handle.runId

const insideStep = (verb: string): StepRunContext => {
  const scoped = inside(verb).step
  if (!scoped) {
    throw new SagaflowError(`${verb}() is per step — call it inside a step's own function`)
  }

  return scoped
}

/**
 * The key this step presents to the outside world. The same on every attempt and every replay
 * of this step, and different for every other step in the run.
 */
export const idempotencyKey = (): string => insideStep('idempotencyKey').idempotencyKey

/** Which attempt of this step is running, from one. */
export const attempt = (): number => insideStep('attempt').attempt

/*
 * The instance a call belongs to, when nobody passed one.
 *
 * Kept opaque so this module does not have to know what a Flow is — the alternative is an import
 * cycle between the verbs and the thing that configures them.
 */
const scopes = new AsyncLocalStorage<object>()

export const runInScope = <Result>(
  instance: object,
  body: () => Promise<Result>,
): Promise<Result> => scopes.run(instance, body)

export const activeScope = (): object | undefined => scopes.getStore()
