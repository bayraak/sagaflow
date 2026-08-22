import { messageOf, WorkflowError } from './errors'
import { createEnvelope, validateEmission, workflowCompletedEvent, type RawEvent } from './events'
import { dispatchEvents } from './outbox'
import { defaultStepConfig } from './step'
import type {
  CompensationOutcome,
  EmitFn,
  EventEnvelope,
  EventsOf,
  StepContext,
  StepRetryConfig,
  WorkflowHandle,
  WorkflowRuntime,
} from './types'

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

type Undo = { name: string; config: StepRetryConfig; run: () => Promise<void> }

export const executeRun = async <Ctx extends WorkflowRuntime, Output>(options: {
  name: string
  runId: string
  ctx: Ctx
  runner: StepRunner
  invoke: (handle: WorkflowHandle<Ctx>) => Promise<Output>
}): Promise<Output> => {
  const { name, runId, ctx, runner, invoke } = options
  const held: EventEnvelope[] = []
  const undos: Undo[] = []
  let seq = 0
  let ordinal = 0
  let failedStep: string | null = null

  /*
   * Envelope ids are the run and a counter, so the whole set is a function of the run rather
   * than of when it happened to be built. A durable body that is invoked twice for one run
   * walks the same emissions in the same order and arrives at the same ids — which is what
   * lets the second write land on rows that already exist instead of handing the consumer
   * copies it has no way to recognise.
   */
  const mint = (event: RawEvent) => {
    held.push(
      createEnvelope({
        type: event.type,
        payload: event.payload,
        tenantId: ctx.tenantId,
        actor: ctx.actor ?? null,
        runId,
        ordinal,
      }),
    )
    ordinal += 1
  }

  // A body emits into the run directly; a step emits into its own result. Validation happens
  // where the caller can still be told about it — at the emit, not at the mint.
  const emitInto = (collect: (event: RawEvent) => void) => (type: string, payload: unknown) => {
    collect({ type, payload: validateEmission(ctx.eventSchemas, type, payload) })
  }

  // The emit a body and a step are handed is one plain function; the overloads it is exposed
  // through are what make the caller's event names and payloads line up, and they cannot be
  // expressed by an implementation that accepts every event there is.
  const bodyEmit = emitInto(mint) as EmitFn<EventsOf<Ctx>>

  const contextFor = (
    idempotencyKey: string,
    collect: (event: RawEvent) => void,
  ): StepContext<Ctx> => ({
    ...ctx,
    runId,
    emit: emitInto(collect) as EmitFn<EventsOf<Ctx>>,
    idempotencyKey,
  })

  const handle: WorkflowHandle<Ctx> = {
    emit: bodyEmit,
    step: async (step, input) => {
      const current = seq
      seq += 1

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

        try {
          const produced = await step.invoke(
            input,
            contextFor(`${runId}:${current}`, (event) => emitted.push(event)),
          )
          await ctx.journal.recordStep({
            tenantId: ctx.tenantId,
            runId,
            seq: current,
            name: step.name,
            status: 'completed',
            attempt,
            output: produced.output,
          })

          return { ...produced, events: emitted }
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

          throw error
        }
      })

      for (const event of result.events) mint(event)

      const compensate = step.compensate
      const compensateWith = result.compensateWith
      if (compensate && compensateWith !== undefined) {
        undos.push({
          name: step.name,
          config: step.config,
          // Undoing a charge is a refund, not the charge again: a different side effect, and
          // so a different key. What an undo emits is dropped with the run it is undoing, so
          // it is collected nowhere.
          run: () =>
            compensate(
              compensateWith,
              contextFor(`${runId}:${current}:undo`, () => undefined),
            ),
        })
      }

      return result.output
    },
  }

  // Backwards, because a saga undoes what it did in the order it did it — and every undo is
  // attempted even when an earlier one refuses, so no completed step is left standing just
  // because its neighbour could not be reversed.
  const compensate = async (): Promise<CompensationOutcome> => {
    let outcome: CompensationOutcome = 'compensated'

    for (let index = undos.length - 1; index >= 0; index -= 1) {
      const undo = undos[index]
      if (!undo) continue

      const current = seq
      seq += 1

      try {
        await runner(`compensate:${undo.name}`, undo.config, async ({ attempt }) => {
          try {
            await undo.run()
            await ctx.journal.recordStep({
              tenantId: ctx.tenantId,
              runId,
              seq: current,
              name: `compensate:${undo.name}`,
              status: 'compensated',
              attempt,
            })
          } catch (error) {
            await ctx.journal.recordStep({
              tenantId: ctx.tenantId,
              runId,
              seq: current,
              name: `compensate:${undo.name}`,
              status: 'failed',
              attempt,
              error: messageOf(error),
            })

            throw error
          }
        })
      } catch {
        outcome = 'failed'
      }
    }

    return outcome
  }

  let output: Output
  try {
    output = await invoke(handle)
  } catch (error) {
    const outcome = await compensate()

    await runner('finish-run', defaultStepConfig, () =>
      ctx.journal.finishRun({
        tenantId: ctx.tenantId,
        runId,
        status: outcome,
        error: messageOf(error),
      }),
    )

    // What the body held is dropped with the run. A compensated run never happened, so nothing
    // downstream is told that it did.
    throw new WorkflowError({
      runId,
      workflowName: name,
      stepName: failedStep,
      outcome,
      cause: error,
    })
  }

  mint({ type: workflowCompletedEvent, payload: { runId, name } })

  /*
   * The run closes and its events are written down in ONE atomic batch, so a completed run
   * whose audit trail was lost is not a state this library can produce. Delivery is a separate,
   * later thing — which is what makes it survivable.
   *
   * The finish goes through the runner like any other step so that a durable platform
   * checkpoints it: an instance invoked again for the same run finds the finish already done
   * and does not close the run twice.
   */
  await runner('finish-run', defaultStepConfig, () =>
    ctx.journal.finishRun({
      tenantId: ctx.tenantId,
      runId,
      status: 'completed',
      output,
      events: held,
    }),
  )

  const sink = ctx.events
  if (sink) {
    // One batch, and then the run says so. A sink that cannot be reached is not the caller's
    // problem: its mutation committed, the events are on the table waiting, and the sweeper
    // carries them. Answering a committed mutation with an error because a queue was down is
    // exactly what the outbox exists to stop, so nothing here is allowed to throw.
    await runner('emit-events', defaultStepConfig, () =>
      dispatchEvents({
        sink,
        envelopes: held,
        markDispatched: (ids) => ctx.journal.markEventsDispatched({ tenantId: ctx.tenantId, ids }),
      }),
    ).catch(() => undefined)
  }

  return output
}
