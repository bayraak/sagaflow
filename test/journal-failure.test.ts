import { describe, expect, it } from 'bun:test'

import { WorkflowError } from '../src/index'
import { completingWorkflow, failingWorkflow } from './helpers/edges'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'

const refusingJournal = (
  ctx: TestRuntime,
  refuse: 'finishRun' | 'markEventsDispatched' | 'recordStep',
  when: (params: Record<string, unknown>) => boolean = () => true,
): TestRuntime => ({
  ...ctx,
  journal: {
    ...ctx.journal,
    [refuse]: async (params: Record<string, unknown>) => {
      if (when(params)) throw new Error(`the journal refused ${refuse}`)

      return ctx.journal[refuse](params as never)
    },
  },
})

describe('the journal refusing mid-run', () => {
  // A step whose work succeeded but whose record could not be written is a step the library
  // cannot prove happened, so it is treated as a failure and the run is closed as one.
  it('fails the run when a step record cannot be written', async () => {
    const { ctx, invocations, runs } = createTestRuntime()
    const refusing = refusingJournal(ctx, 'recordStep')

    const thrown = await completingWorkflow()
      .run({ input: { mark: 'x' }, ctx: refusing })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(invocations).toContain('invoke:only')
    expect(runs[0]?.status).toBe('compensated')
  })

  // The honest edge underneath it, written down rather than assumed: the undo is registered
  // from what the step RETURNED, and a refused completion record throws before the step ever
  // returns — so the work that step did is NOT undone. This is the durable-replay rule
  // (register from the return value, never a closure) meeting the one case where it costs
  // something, and the cost is real. The compensation chain covers the steps BEHIND it, which
  // is why the run still closes as compensated rather than failed.
  it('does not undo the step whose own record refused', async () => {
    const { ctx, invocations } = createTestRuntime()
    const refusing = refusingJournal(ctx, 'recordStep')

    await completingWorkflow()
      .run({ input: { mark: 'x' }, ctx: refusing })
      .catch(() => undefined)

    expect(invocations).toEqual(['invoke:only'])
  })

  // A refused record on a LATER step still unwinds everything behind it, because those undos
  // were registered when their own steps returned.
  it('still undoes the steps behind a refused record', async () => {
    const { ctx, invocations } = createTestRuntime()
    const refusing = refusingJournal(ctx, 'recordStep', (params) => params.name === 'second')

    await failingWorkflow()
      .run({ input: { mark: 'x' }, ctx: refusing })
      .catch(() => undefined)

    expect(invocations).toEqual(['invoke:first', 'invoke:second', 'compensate:first'])
  })

  // The finish is the run's one atomic write, and there is nothing underneath it to fall back
  // on: what the caller gets is the journal's own refusal, unwrapped, because no compensation
  // ran and calling it a workflow failure would say the steps were undone when they were not.
  it("raises the journal's own failure when the finish refuses", async () => {
    const { ctx, sent } = createTestRuntime()
    const refusing = refusingJournal(ctx, 'finishRun')

    const thrown = await completingWorkflow()
      .run({ input: { mark: 'x' }, ctx: refusing })
      .catch((error: unknown) => error)

    expect(thrown).not.toBeInstanceOf(WorkflowError)
    expect((thrown as Error).message).toContain('the journal refused finishRun')
    expect(sent).toEqual([])
  })

  // The drain's second half. The events went out; the note saying so did not. The caller is
  // untouched, because the sweep will send them again and the consumer knows the ids.
  it('leaves the caller untouched when the dispatch note refuses', async () => {
    const { ctx, sent, dispatched } = createTestRuntime()
    const refusing = refusingJournal(ctx, 'markEventsDispatched')

    const result = await completingWorkflow().run({ input: { mark: 'x' }, ctx: refusing })

    expect(!result.deduplicated && result.output).toEqual({ finished: 'only:x' })
    expect(sent.map((message) => message.type)).toContain('invoice.voided')
    expect(dispatched).toEqual([])
  })
})

describe('the sink refusing a drain the caller already committed', () => {
  it('does not fail the caller', async () => {
    const { ctx } = createTestRuntime({ sinkRefuses: true })

    const result = await completingWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(result.deduplicated).toBe(false)
    expect(!result.deduplicated && result.output).toEqual({ finished: 'only:x' })
  })

  it('leaves the run completed', async () => {
    const { ctx, runs, finishes } = createTestRuntime({ sinkRefuses: true })

    await completingWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(runs[0]?.status).toBe('completed')
    expect(finishes.map((finish) => finish.status)).toEqual(['completed'])
  })

  // The whole point of the outbox: the rows are on the table, unmarked, waiting for the sweep.
  it('leaves the rows undispatched', async () => {
    const { ctx, outbox, dispatched } = createTestRuntime({ sinkRefuses: true })

    await completingWorkflow().run({ input: { mark: 'x' }, ctx })

    expect(outbox.map((message) => message.type)).toEqual(['invoice.voided', 'workflow.completed'])
    expect(dispatched).toEqual([])
  })
})
