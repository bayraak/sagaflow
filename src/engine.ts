import { SagaCancelledError } from './cancel.js'
import { messageOf, SagaError } from './errors.js'
import { createEnvelope, lifecycleEvents, validateEmission, type RawEvent } from './events.js'
import { compensationIdempotencyKey, stepIdempotencyKey } from './identity.js'
import { dispatchEvents } from './outbox.js'
import { validate } from './schema.js'
import {
  assertNameIsAvailable,
  budgetOf,
  compensationStepName,
  defaultStepConfig,
  reservedStepNames,
} from './step.js'
import type {
  CompensationOutcome,
  CompensationReason,
  InlineStepOptions,
  Step,
  EmitFn,
  EventEnvelope,
  EventsOf,
  StandardSchemaV1,
  StepContext,
  StepRetryConfig,
  WorkflowHandle,
  WorkflowRuntime,
} from './types.js'

/**
 * The one difference between the two executors: how a unit of work is carried out. Inline
 * calls it; durable hands it to the platform's step primitive, which checkpoints and retries
 * it. Everything else — ordering, the step trail, the reverse compensation, the held events —
 * is one implementation, proven once.
 */
export type StepRunner = <Output>(
  name: string,
  config: StepRetryConfig,
  run: (ctx: { attempt: number }) => Promise<Output>,
) => Promise<Output>

// An observability backend having a bad day is not a reason to refuse somebody's invoice, so
// whatever a hook throws is swallowed here and nowhere else has to think about it.
const watch = <Fact>(hook: ((fact: Fact) => void) | undefined, fact: () => Fact): void => {
  if (!hook) return

  try {
    hook(fact())
  } catch {
    // deliberately ignored
  }
}

/*
 * Every member is started, and every member is allowed to STOP before the first rejection is
 * reported. `Promise.all` reports the first rejection immediately and leaves the others running,
 * which is how a step finishes a millisecond later with an undo nobody is left to run. The name
 * is for the reader — the group is not journaled, the steps inside it are.
 */
const all = async <Results extends readonly unknown[]>(
  _name: string,
  members: { [Index in keyof Results]: () => PromiseLike<Results[Index]> },
): Promise<Results> => {
  const settled = await Promise.allSettled(
    (members as ReadonlyArray<() => PromiseLike<unknown>>).map((member) => member()),
  )

  const refused = settled.find((outcome) => outcome.status === 'rejected')
  if (refused && refused.status === 'rejected') throw refused.reason

  return settled.map((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value : undefined,
  ) as unknown as Results
}

type Undo<Ctx> = {
  seq: number
  name: string
  config: StepRetryConfig
  run(ctx: StepContext<Ctx>, reason: CompensationReason): Promise<void>
}

export const executeRun = async <Ctx extends WorkflowRuntime, Output>(options: {
  name: string
  runId: string
  ctx: Ctx
  runner: StepRunner
  invoke: (handle: WorkflowHandle<Ctx>) => Promise<Output>
  output?: StandardSchemaV1
}): Promise<Output> => {
  const { name, runId, ctx, runner, invoke } = options
  const held: EventEnvelope[] = []
  const undos: Undo<Ctx>[] = []
  const inflight: Promise<unknown>[] = []
  const usedNames = new Set<string>()
  let seq = 0
  let ordinal = 0
  let failedStep: string | null = null
  let cancelledAfter: string | null = null
  const startedAt = Date.now()

  watch(ctx.observer?.onRunStart, () => ({ runId, name, tenantId: ctx.tenantId }))

  /*
   * Envelope ids are the run and a counter, so the whole set is a function of the run rather
   * than of when it happened to be built. A durable body that is invoked twice for one run
   * walks the same emissions in the same order and arrives at the same ids — which is what
   * lets the second write land on rows that already exist instead of handing the consumer
   * copies it has no way to recognise.
   */
  const envelopeFor = (event: RawEvent): EventEnvelope => {
    const envelope = createEnvelope({
      type: event.type,
      payload: event.payload,
      tenantId: ctx.tenantId,
      actor: ctx.actor ?? null,
      runId,
      ordinal,
    })
    ordinal += 1

    return envelope
  }

  const mint = (event: RawEvent): void => {
    held.push(envelopeFor(event))
  }

  // A body emits into the run directly; a step emits into its own result. Validation happens
  // where the caller can still be told about it — at the emit, not at the mint.
  const emitInto =
    (collect: (event: RawEvent) => void) =>
    (type: string, payload: unknown): void => {
      collect({ type, payload: validateEmission(ctx.eventSchemas, type, payload) })
    }

  // The emit a body and a step are handed is one plain function; the overloads it is exposed
  // through are what make the caller's event names and payloads line up, and they cannot be
  // expressed by an implementation that accepts every event there is.
  const bodyEmit = emitInto(mint) as EmitFn<EventsOf<Ctx>>

  const contextFor = (
    idempotencyKey: string,
    attempt: number,
    collect: (event: RawEvent) => void,
  ): StepContext<Ctx> => ({
    ...ctx,
    runId,
    emit: emitInto(collect) as EmitFn<EventsOf<Ctx>>,
    idempotencyKey,
    attempt,
  })

  const runStep = async <StepInput, StepOutput>(
    step: Step<Ctx, StepInput, StepOutput>,
    input: StepInput,
  ): Promise<StepOutput> => {
    // Once the run has been told to stop, nothing else starts. A body is somebody else's code
    // and somebody else's code has try/catch in it; swallowing the cancellation must not buy
    // it another step.
    if (cancelledAfter !== null) throw new SagaCancelledError(runId)

    /*
     * The most expensive durable bug there is, and completely silent: a platform memoises step
     * results BY NAME, so a second use of one definition in one run is handed the first use's
     * result and the work it was asked to do never happens — the digest goes to the first
     * recipient three times and the other two hear nothing. Inline it appears to work, which is
     * worse, because the bug is then only found in production.
     */
    if (usedNames.has(step.name)) {
      throw new Error(
        `step "${step.name}" was already used in this run — wrap it with namedStep(step, "${step.name}-2")`,
      )
    }
    usedNames.add(step.name)

    const current = seq
    seq += 1
    let cancellationRequested = false

    /*
     * What a step emitted is part of what a step produced, so it travels home in the step's
     * result and is memoised with it. On a replay the body of the step does not run and its
     * `emit` calls never happen — an announcement kept anywhere else would be lost, and the
     * run would close having said less the second time than the first.
     *
     * The compensation is registered from the returned value for the same reason, and never
     * from a closure taken during the step: a closure does not survive a replay either.
     */
    const result = await runner(step.name, step.config, async ({ attempt }) => {
      const emitted: RawEvent[] = []
      const stepStartedAt = Date.now()
      watch(ctx.observer?.onStepStart, () => ({
        runId,
        name: step.name,
        seq: current,
        attempt,
      }))

      try {
        const produced = await step.run(
          input,
          contextFor(stepIdempotencyKey(runId, current), attempt, (event) => emitted.push(event)),
        )
        const recorded = await ctx.journal.recordStep({
          tenantId: ctx.tenantId,
          runId,
          seq: current,
          name: step.name,
          status: 'completed',
          attempt,
          output: produced,
        })
        cancellationRequested = recorded.cancellationRequested
        watch(ctx.observer?.onStepEnd, () => ({
          runId,
          name: step.name,
          seq: current,
          attempt,
          status: 'completed' as const,
          durationMs: Date.now() - stepStartedAt,
        }))

        return { output: produced, events: emitted }
      } catch (error) {
        failedStep = step.name
        await ctx.journal.recordStep({
          tenantId: ctx.tenantId,
          runId,
          seq: current,
          name: step.name,
          status: 'failed',
          attempt,
          error: messageOf(error),
        })
        watch(ctx.observer?.onStepEnd, () => ({
          runId,
          name: step.name,
          seq: current,
          attempt,
          status: 'failed' as const,
          durationMs: Date.now() - stepStartedAt,
        }))

        throw error
      }
    })

    for (const event of result.events) mint(event)

    // One rule: the undo is handed exactly what the step returned. Registered from the returned
    // value and never from a closure taken during the step, because a closure does not survive a
    // replay — the step's body will not run again, and anything living in it is gone.
    const declaredUndo = step.undo
    if (declaredUndo) {
      undos.push({
        seq: current,
        name: step.name,
        config: step.config,
        run: (undoContext, reason) => declaredUndo(result.output, undoContext, reason),
      })
    }

    // Noticed only now, and acted on only here: a step already running is never interrupted,
    // and the undo of the step that just finished is registered above before this throws, so
    // a cancelled run leaves nothing standing.
    if (cancellationRequested) {
      cancelledAfter = step.name

      throw new SagaCancelledError(runId)
    }

    return result.output
  }

  function stepCall<StepInput, StepOutput>(
    step: Step<Ctx, StepInput, StepOutput>,
    input: StepInput,
  ): Promise<StepOutput>
  function stepCall<StepOutput>(
    name: string,
    run: (ctx: StepContext<Ctx>) => Promise<StepOutput>,
    options?: InlineStepOptions<Ctx, StepOutput>,
  ): Promise<StepOutput>
  function stepCall(first: unknown, second: unknown, third?: unknown): Promise<unknown> {
    if (typeof first !== 'string') {
      return runStep(first as Step<Ctx, unknown, unknown>, second)
    }

    // The inline form is not a second, weaker path: it builds the same Step the reusable form
    // builds — same name guard, same budget rules — and hands it to the same runner.
    const declared = (third ?? {}) as InlineStepOptions<Ctx, unknown>
    assertNameIsAvailable(first)

    const inline: Step<Ctx, undefined, unknown> = {
      name: first,
      config: budgetOf(declared),
      run: (_input, stepContext) =>
        (second as (ctx: StepContext<Ctx>) => Promise<unknown>)(stepContext),
      ...(declared.undo === undefined ? {} : { undo: declared.undo }),
    }

    return runStep(inline, undefined)
  }

  /*
   * The engine keeps hold of every step that is still running, because `Promise.all` rejects the
   * moment the first of them does while the others are still going. Unwinding there and then
   * would leave a step that finished a millisecond later registering an undo with nobody left to
   * run it: the effect stays, the run says it was compensated, and the two disagree for ever.
   */
  function trackedStep<StepInput, StepOutput>(
    step: Step<Ctx, StepInput, StepOutput>,
    input: StepInput,
  ): Promise<StepOutput>
  function trackedStep<StepOutput>(
    name: string,
    run: (ctx: StepContext<Ctx>) => Promise<StepOutput>,
    options?: InlineStepOptions<Ctx, StepOutput>,
  ): Promise<StepOutput>
  function trackedStep(first: unknown, second: unknown, third?: unknown): Promise<unknown> {
    const running =
      typeof first === 'string'
        ? stepCall(
            first,
            second as (ctx: StepContext<Ctx>) => Promise<unknown>,
            third as InlineStepOptions<Ctx, unknown> | undefined,
          )
        : stepCall(first as Step<Ctx, unknown, unknown>, second)
    inflight.push(running.catch(() => undefined))

    return running
  }

  const handle: WorkflowHandle<Ctx> = {
    runtime: ctx,
    runId,
    emit: bodyEmit,
    step: trackedStep,
    all,
  }

  /*
   * Backwards, by the order the steps were STARTED in — which under concurrency is not the
   * order they finished in, and the difference matters. Completion order is not stable across a
   * durable re-invocation: a replayed step comes back from the journal instantly, so steps
   * complete in the order they were called and the same body would unwind one way the first
   * time and another way the second. Start order is a property of the body.
   *
   * Every undo is attempted even when an earlier one refuses, so no completed step is left
   * standing just because its neighbour could not be reversed.
   */
  const compensated: string[] = []
  const failedCompensations: string[] = []

  const compensate = async (cause: unknown): Promise<'compensated' | 'failed'> => {
    // Nothing is undone until everything has stopped, so that every undo there is going to be
    // is registered before the first one runs.
    await Promise.allSettled(inflight)

    let outcome: 'compensated' | 'failed' = 'compensated'

    for (const undo of undos.toSorted((left, right) => right.seq - left.seq)) {
      const current = seq
      seq += 1

      try {
        await runner(compensationStepName(undo.name), undo.config, async ({ attempt }) => {
          const undoStartedAt = Date.now()
          watch(ctx.observer?.onCompensationStart, () => ({
            runId,
            name: undo.name,
            seq: undo.seq,
            attempt,
          }))

          try {
            // Undoing a charge is a refund, not the charge again: a different side effect, and
            // so a different key. What an undo emits is dropped with the run it is undoing, so
            // it is collected nowhere.
            await undo.run(
              contextFor(compensationIdempotencyKey(runId, undo.seq), attempt, () => undefined),
              { cause },
            )
            await ctx.journal.recordStep({
              tenantId: ctx.tenantId,
              runId,
              seq: current,
              name: compensationStepName(undo.name),
              status: 'compensated',
              attempt,
            })
            compensated.push(undo.name)
            watch(ctx.observer?.onCompensationEnd, () => ({
              runId,
              name: undo.name,
              seq: undo.seq,
              attempt,
              status: 'compensated' as const,
              durationMs: Date.now() - undoStartedAt,
            }))
          } catch (error) {
            await ctx.journal.recordStep({
              tenantId: ctx.tenantId,
              runId,
              seq: current,
              name: compensationStepName(undo.name),
              status: 'failed',
              attempt,
              error: messageOf(error),
            })
            watch(ctx.observer?.onCompensationEnd, () => ({
              runId,
              name: undo.name,
              seq: undo.seq,
              attempt,
              status: 'failed' as const,
              durationMs: Date.now() - undoStartedAt,
            }))

            throw error
          }
        })
      } catch {
        outcome = 'failed'
        failedCompensations.push(undo.name)
      }
    }

    return outcome
  }

  let output: Output
  try {
    const produced = await invoke(handle)

    // Stopping is not the body's decision. A body that caught the cancellation and carried on
    // does not get to hand back a completed run.
    if (cancelledAfter !== null) throw new SagaCancelledError(runId)

    /*
     * A body that returns the wrong thing is a body that failed, however cheerfully it
     * returned: the run promised its caller a shape, and this is the last honest moment to
     * notice that it did not keep the promise. So a refusal here goes down the same path as a
     * step that threw — the run is undone and closed as compensated, not written down as
     * completed with a value nobody can use.
     */
    output = options.output
      ? ((await validate(options.output, produced, `the output of ${name}`)) as Output)
      : produced
  } catch (error) {
    const undone = await compensate(error)

    // Somebody changing their mind and something breaking are different facts, and a run that
    // was asked to stop and came all the way back is `cancelled`. If an undo refused, it is
    // `failed` like any other run that left something standing — calling that one cancelled
    // would tell a reader the tenant was left whole.
    const outcome: CompensationOutcome =
      error instanceof SagaCancelledError && undone === 'compensated' ? 'cancelled' : undone

    /*
     * What the body held is dropped with the run: a compensated run never happened, so nothing
     * downstream is told that it did. How the run ENDED is a different fact, and one somebody
     * does have to be told — an audit log, a metrics mirror, an operator reading a dashboard.
     * It is a fact about the run rather than about the change, so it is the only thing a
     * compensated run puts on the table, and it travels in the write that closes the run like
     * every other event does.
     *
     * It is not drained here. A run that fell over is on nobody's hot path, its announcement
     * is not worth a queue call on the way out of a failure, and the sweeper carries it.
     */
    const announcement = envelopeFor({
      type: lifecycleEvents.compensated,
      payload: { runId, name, error: messageOf(error), outcome },
    })

    await runner(reservedStepNames.finishRun, defaultStepConfig, () =>
      ctx.journal.finishRun({
        tenantId: ctx.tenantId,
        runId,
        status: outcome,
        error: messageOf(error),
        events: [announcement],
      }),
    )

    watch(ctx.observer?.onRunEnd, () => ({
      runId,
      name,
      status: outcome,
      durationMs: Date.now() - startedAt,
    }))

    throw new SagaError({
      runId,
      workflowName: name,
      stepName: failedStep ?? cancelledAfter,
      outcome,
      compensated,
      failedCompensations,
      cause: error,
    })
  }

  mint({ type: lifecycleEvents.completed, payload: { runId, name } })

  /*
   * The run closes and its events are written down in ONE atomic batch, so a completed run
   * whose audit trail was lost is not a state this library can produce. Delivery is a separate,
   * later thing — which is what makes it survivable.
   *
   * The finish goes through the runner like any other step so that a durable platform
   * checkpoints it: an instance invoked again for the same run finds the finish already done
   * and does not close the run twice.
   */
  await runner(reservedStepNames.finishRun, defaultStepConfig, () =>
    ctx.journal.finishRun({
      tenantId: ctx.tenantId,
      runId,
      status: 'completed',
      output,
      events: held,
    }),
  )

  watch(ctx.observer?.onRunEnd, () => ({
    runId,
    name,
    status: 'completed' as const,
    durationMs: Date.now() - startedAt,
  }))

  const sink = ctx.events
  if (sink) {
    // One batch, and then the run says so. A sink that cannot be reached is not the caller's
    // problem: its mutation committed, the events are on the table waiting, and the sweeper
    // carries them. Answering a committed mutation with an error because a queue was down is
    // exactly what the outbox exists to stop, so nothing here is allowed to throw.
    await runner(reservedStepNames.emitEvents, defaultStepConfig, () =>
      dispatchEvents({
        sink,
        envelopes: held,
        markDispatched: (ids) => ctx.journal.markEventsDispatched({ tenantId: ctx.tenantId, ids }),
      }),
    ).catch(() => undefined)
  }

  return output
}
