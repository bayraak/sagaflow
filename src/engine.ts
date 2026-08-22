import { messageOf, WorkflowError } from './errors'
import { createEnvelope, validateEmission, workflowCompletedEvent } from './events'
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
  let failedStep: string | null = null

  const record = (type: string, payload: unknown) => {
    held.push(
      createEnvelope({
        type,
        payload: validateEmission(ctx.eventSchemas, type, payload),
        tenantId: ctx.tenantId,
        actor: ctx.actor ?? null,
        runId,
      }),
    )
  }

  // The emit a body and a step are handed is one plain function; the overloads it is exposed
  // through are what make the caller's event names and payloads line up, and they cannot be
  // expressed by an implementation that accepts every event there is.
  const emit = record as EmitFn<EventsOf<Ctx>>

  const stepContext: StepContext<Ctx> = { ...ctx, runId, emit }

  const handle: WorkflowHandle<Ctx> = {
    emit,
    step: async (step, input) => {
      const current = seq
      seq += 1

      // The compensation is registered from the value the step RETURNED, never from a closure
      // taken during it: on a durable replay the step body does not run again, and a
      // compensation that lived in that closure would be lost with it.
      const result = await runner(step.name, step.config, async ({ attempt }) => {
        try {
          const produced = await step.invoke(input, stepContext)
          await ctx.journal.recordStep({
            tenantId: ctx.tenantId,
            runId,
            seq: current,
            name: step.name,
            status: 'completed',
            attempt,
            output: produced.output,
          })

          return produced
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

      const compensate = step.compensate
      const compensateWith = result.compensateWith
      if (compensate && compensateWith !== undefined) {
        undos.push({
          name: step.name,
          config: step.config,
          run: () => compensate(compensateWith, stepContext),
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
    await ctx.journal.finishRun({
      tenantId: ctx.tenantId,
      runId,
      status: outcome,
      error: messageOf(error),
    })

    // The held events are dropped with the run. A compensated run never happened, so nothing
    // downstream is told that it did.
    throw new WorkflowError({
      runId,
      workflowName: name,
      stepName: failedStep,
      outcome,
      cause: error,
    })
  }

  record(workflowCompletedEvent, { runId, name })

  // The run closes and its events are written down in ONE atomic batch, so a completed run
  // whose audit trail was lost is not a state this library can produce. Delivery is a
  // separate, later thing — which is what makes it survivable.
  await ctx.journal.finishRun({
    tenantId: ctx.tenantId,
    runId,
    status: 'completed',
    output,
    events: held,
  })

  const sink = ctx.events
  if (sink) {
    // One batch, and then the run says so. A queue that cannot be reached is not the caller's
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
