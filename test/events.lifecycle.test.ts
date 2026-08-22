import { describe, expect, it } from 'bun:test'

import { completingWorkflow, failingWorkflow } from './helpers/edges'
import { createTestRuntime, firstFinish } from './helpers/runtime'

// A run that was undone is still a fact somebody has to be told about: an audit log wants it,
// a metrics mirror wants it, and an operator reading a dashboard wants it most of all. It is a
// fact about the RUN, not about the change — the change did not happen — which is why it is
// the only thing a compensated run puts on the table.
describe('a run announces how it ended', () => {
  it('announces a completed run and nothing else about the run', async () => {
    const harness = createTestRuntime()

    await completingWorkflow().run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.outbox.map((event) => event.type)).toEqual([
      'invoice.voided',
      'workflow.completed',
    ])
  })

  it('announces a compensated run', async () => {
    const harness = createTestRuntime()

    await failingWorkflow({ emitsBeforeFailing: true })
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.compensated'])
  })

  it('carries the run, the name, the failure and how far the undo got', async () => {
    const harness = createTestRuntime()

    await failingWorkflow()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.outbox[0]?.payload).toEqual({
      runId: 'run_1',
      name: 'edge.failing',
      error: 'third refused',
      outcome: 'compensated',
    })
  })

  // `compensated` and `failed` are not the same news: one says the change was fully reversed,
  // the other says something is still standing that should not be.
  it('says when the undoing itself did not finish', async () => {
    const harness = createTestRuntime()

    await failingWorkflow({ compensateFailsOn: 'all' })
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.outbox[0]?.payload).toMatchObject({ outcome: 'failed' })
  })

  it('travels in the same write that closes the run', async () => {
    const harness = createTestRuntime()

    await failingWorkflow()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(firstFinish(harness.finishes).status).toBe('compensated')
    expect(firstFinish(harness.finishes).events.map((event) => event.type)).toEqual([
      'workflow.compensated',
    ])
  })

  // A compensated run is not on anybody's hot path, and its announcement is not worth a queue
  // call on the way out of a failure. It waits on the table for the sweeper.
  it('leaves the announcement for the sweeper rather than draining it', async () => {
    const harness = createTestRuntime()

    await failingWorkflow()
      .run({ input: { mark: 'x' }, ctx: harness.ctx })
      .catch(() => undefined)

    expect(harness.sent).toEqual([])
    expect(harness.dispatched).toEqual([])
  })
})
