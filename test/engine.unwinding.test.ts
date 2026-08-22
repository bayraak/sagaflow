import { describe, expect, it } from 'bun:test'

import { WorkflowError } from '../src/index'
import { failingWorkflow } from './helpers/edges'
import { createTestRuntime } from './helpers/runtime'

describe('a compensation that refuses while the saga is unwinding', () => {
  it('attempts every undo even when every one refuses', async () => {
    const { ctx, invocations } = createTestRuntime()

    await failingWorkflow({ compensateFailsOn: 'all' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(invocations).toEqual([
      'invoke:first',
      'invoke:second',
      'invoke:third',
      'compensate:second',
      'compensate:first',
    ])
  })

  it('closes a run whose undoing refused throughout as failed', async () => {
    const { ctx, runs, finishes } = createTestRuntime()

    const thrown = await failingWorkflow({ compensateFailsOn: 'all' })
      .run({ input: { mark: 'x' }, ctx })
      .catch((error: unknown) => error)

    expect(thrown instanceof WorkflowError && thrown.outcome).toBe('failed')
    expect(runs[0]?.status).toBe('failed')
    expect(finishes.map((finish) => finish.status)).toEqual(['failed'])
  })

  // The undo that refuses is the FIRST one attempted, and the one behind it is the last thing
  // standing between the tenant and a half-applied mutation. A loop that gave up on the first
  // refusal would leave it standing.
  it('still attempts the undo behind a refused one', async () => {
    const { ctx, invocations } = createTestRuntime()

    await failingWorkflow({ compensateFailsOn: 'second' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(invocations).toContain('compensate:first')
  })

  // A refusal anywhere in the unwinding is the whole run's verdict: `compensated` would tell a
  // reader the mutation was fully reversed, and it was not.
  it('fails the whole run on one refused undo', async () => {
    const { ctx, runs } = createTestRuntime()

    await failingWorkflow({ compensateFailsOn: 'first' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(runs[0]?.status).toBe('failed')
  })

  it('closes the run exactly once however badly it unwound', async () => {
    const { ctx, finishes } = createTestRuntime()

    await failingWorkflow({ compensateFailsOn: 'all' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    expect(finishes).toHaveLength(1)
  })
})

describe('the events a failed run was holding', () => {
  it('never writes an event emitted before the failure to the outbox', async () => {
    const { ctx, outbox, finishes, invocations } = createTestRuntime()

    await failingWorkflow({ emitsBeforeFailing: true })
      .run({ input: { mark: 'INV-1' }, ctx })
      .catch(() => undefined)

    // The body reached the third step, so it went past the emit on the way — the drop below is
    // a drop, not an emission that never happened.
    expect(invocations).toContain('invoke:third')
    expect(outbox).toEqual([])
    expect(finishes[0]?.events).toEqual([])
  })

  it('never sends an event emitted before the failure', async () => {
    const { ctx, sent, batches } = createTestRuntime()

    await failingWorkflow({ emitsBeforeFailing: true })
      .run({ input: { mark: 'INV-1' }, ctx })
      .catch(() => undefined)

    expect(sent).toEqual([])
    expect(batches).toEqual([])
  })

  // A compensation runs with the same handle its step had, so it CAN emit. What it emits is
  // held with everything else the run held — and a run that is being undone drops all of it.
  // Nothing downstream is told that a mutation which never happened was reversed.
  it('drops an event emitted while undoing along with the run', async () => {
    const { ctx, outbox, sent, finishes, invocations } = createTestRuntime()

    await failingWorkflow({ emitsWhileUndoingOn: 'first' })
      .run({ input: { mark: 'x' }, ctx })
      .catch(() => undefined)

    // The undo that emits actually ran, so the emission happened and was then dropped.
    expect(invocations).toContain('compensate:first')
    expect(outbox).toEqual([])
    expect(sent).toEqual([])
    expect(finishes[0]?.events).toEqual([])
  })
})
