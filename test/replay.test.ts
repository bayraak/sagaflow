import { describe, expect, it } from 'bun:test'

import { saga, sagaflow, step, type WorkflowLauncher } from '@bayraak/sagaflow'
import { createMemoryJournal } from '@bayraak/sagaflow/memory'

const ship = saga(
  'thing.ship-replay',
  { durable: true, idempotent: (input: { mark: string }) => `ship:${input.mark}` },
  async (input: { mark: string }) => step('ship', async () => input.mark),
)

const write = saga('thing.write-replay', async (input: { mark: string }) =>
  step('write', async () => input.mark),
)

const recordingLauncher = (): { launcher: WorkflowLauncher; created: string[] } => {
  const created: string[] = []

  return {
    created,
    launcher: {
      create: async (instance) => {
        created.push(instance.id ?? 'generated')

        return { id: instance.id ?? 'generated' }
      },
    },
  }
}

const configured = (): ReturnType<typeof sagaflow> & {
  journal: ReturnType<typeof createMemoryJournal>
  created: string[]
} => {
  const journal = createMemoryJournal()
  const platform = recordingLauncher()
  const flow = sagaflow({
    journal: journal.journal,
    launcher: platform.launcher,
    sagas: [ship, write],
  })

  return Object.assign(flow, { journal, created: platform.created })
}

/*
 * A replay is a new run that says which run it is redoing, and it is keyed on THAT rather than on
 * the input. Most definitions derive their key from the input, so a replay that kept the
 * definition's own key would arrive at the very key the original run claimed and be told "already
 * done" — the one answer a replay must never give, because being already done is why somebody is
 * asking.
 */
describe('replaying a run', () => {
  it('opens a new run that points back at the old one', async () => {
    const flow = configured()

    const original = await ship.start({ mark: 'A' }, flow)
    const replayed = await flow.replay(original.runId)

    expect(replayed.deduplicated).toBe(false)
    expect(replayed.runId).not.toBe(original.runId)
    expect(flow.journal.runs.map((run) => [run.name, run.replayOf])).toEqual([
      ['thing.ship-replay', null],
      ['thing.ship-replay', original.runId],
    ])
  })

  it('starts a second instance for it', async () => {
    const flow = configured()

    const original = await ship.start({ mark: 'B' }, flow)
    const replayed = await flow.replay(original.runId)

    expect(flow.created).toHaveLength(2)
    expect(flow.created[1]).toContain(replayed.runId)
  })

  it('runs it with the input the original was given', async () => {
    const flow = configured()

    const original = await ship.start({ mark: 'C' }, flow)
    await flow.replay(original.runId)

    expect(flow.journal.runs.map((run) => run.input)).toEqual([{ mark: 'C' }, { mark: 'C' }])
  })

  // Asking for the same replay twice is still one replay, so an agent that retries does not send
  // the same email twice.
  it('is one replay however many times it is asked for', async () => {
    const flow = configured()

    const original = await ship.start({ mark: 'D' }, flow)
    const once = await flow.replay(original.runId)
    const twice = await flow.replay(original.runId)

    expect(twice).toEqual({ runId: once.runId, deduplicated: true })
    expect(flow.journal.runs).toHaveLength(2)
  })

  it('leaves the original run exactly as it was', async () => {
    const flow = configured()

    const original = await ship.start({ mark: 'E' }, flow)
    await flow.replay(original.runId)

    const before = flow.journal.runs.find((run) => run.id === original.runId)

    expect(before?.status).toBe('running')
    expect(before?.replayOf).toBeNull()
  })

  it('replays a run that failed, which is the whole point', async () => {
    const flow = configured()

    const original = await ship.start({ mark: 'F' }, flow)
    await flow.journal.journal.finishRun({
      tenantId: 'default',
      runId: original.runId,
      status: 'failed',
      error: 'the instance died',
    })

    const replayed = await flow.replay(original.runId)

    expect(replayed.deduplicated).toBe(false)
    expect(flow.journal.runs).toHaveLength(2)
  })

  it('says so when there is no such run', async () => {
    const flow = configured()

    expect(flow.replay('run_nowhere')).rejects.toThrow('run_nowhere')
  })

  it('says so when the saga is not registered', async () => {
    const journal = createMemoryJournal()
    const platform = recordingLauncher()
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher, sagas: [] })

    const runId = await journal.journal.insertRun({
      tenantId: 'default',
      name: 'thing.forgotten',
      execution: 'durable',
      idempotencyKey: null,
      input: {},
    })

    expect(flow.replay(runId)).rejects.toThrow('thing.forgotten')
  })

  // An inline run has no instance to start. Replaying one would create a durable instance for a
  // definition that was never durable, which is a stranger failure than being told no.
  it('refuses to replay an inline run', async () => {
    const flow = configured()

    await write({ mark: 'G' }, flow)
    const runId = flow.journal.runs[0]?.id as string

    expect(flow.replay(runId)).rejects.toThrow('durable')
  })
})
