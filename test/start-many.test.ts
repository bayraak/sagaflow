import { describe, expect, it } from 'bun:test'

import {
  saga,
  sagaflow,
  startDurableWorkflows,
  step,
  type StandardSchemaV1,
  type WorkflowLauncher,
} from 'sagaflow-js'
import { createMemoryJournal } from 'sagaflow-js/memory'

import { definitionOf } from '../src/saga.js'

const ship = saga(
  'thing.ship-many',
  { durable: true, idempotent: (input: { mark: string }) => `ship:${input.mark}` },
  async (input: { mark: string }) => step('ship', async () => input.mark),
)

const batchingLauncher = (
  options: { refusesBatch?: boolean; withoutBatch?: boolean } = {},
): { launcher: WorkflowLauncher; batches: number[]; created: string[] } => {
  const batches: number[] = []
  const created: string[] = []

  const create: WorkflowLauncher['create'] = async (instance) => {
    created.push(instance.id ?? 'generated')

    return { id: instance.id ?? 'generated' }
  }

  if (options.withoutBatch) return { launcher: { create }, batches, created }

  return {
    batches,
    created,
    launcher: {
      create,
      createBatch: async (instances) => {
        if (options.refusesBatch) throw new Error('the platform is unavailable')
        batches.push(instances.length)
        for (const instance of instances) created.push(instance.id ?? 'generated')

        return instances.map((instance) => ({ id: instance.id ?? 'generated' }))
      },
    },
  }
}

// Cloudflare limits instance creation to a hundred a second per workflow, and creating a hundred
// instances one call at a time is a hundred round trips. createBatch exists for exactly this,
// and a fan-out is the shape that needs it.
describe('starting many durable runs at once', () => {
  it('opens a run record for each and creates them in one call', async () => {
    const journal = createMemoryJournal()
    const platform = batchingLauncher()
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher })

    const started = await startDurableWorkflows({
      launcher: platform.launcher,
      definition: definitionOf(ship) as never,
      inputs: [{ mark: 'A' }, { mark: 'B' }, { mark: 'C' }],
      ctx: flow.runtime,
    })

    expect(started).toHaveLength(3)
    expect(started.every((one) => one.deduplicated === false)).toBe(true)
    expect(journal.runs.map((run) => run.name)).toEqual([
      'thing.ship-many',
      'thing.ship-many',
      'thing.ship-many',
    ])
    expect(platform.batches).toEqual([3])
  })

  it('leaves out the ones already running, and still creates the rest', async () => {
    const journal = createMemoryJournal()
    const platform = batchingLauncher()
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher })

    await startDurableWorkflows({
      launcher: platform.launcher,
      definition: definitionOf(ship) as never,
      inputs: [{ mark: 'A' }],
      ctx: flow.runtime,
    })

    const again = await startDurableWorkflows({
      launcher: platform.launcher,
      definition: definitionOf(ship) as never,
      inputs: [{ mark: 'A' }, { mark: 'B' }],
      ctx: flow.runtime,
    })

    expect(again.map((one) => one.deduplicated)).toEqual([true, false])
    expect(platform.batches).toEqual([1, 1])
    expect(journal.runs).toHaveLength(2)
  })

  it('falls back to one call each when the binding cannot batch', async () => {
    const journal = createMemoryJournal()
    const platform = batchingLauncher({ withoutBatch: true })
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher })

    const started = await startDurableWorkflows({
      launcher: platform.launcher,
      definition: definitionOf(ship) as never,
      inputs: [{ mark: 'A' }, { mark: 'B' }],
      ctx: flow.runtime,
    })

    expect(started).toHaveLength(2)
    expect(platform.created).toHaveLength(2)
    expect(platform.batches).toEqual([])
  })

  // The run records exist before the instances do, so a refused batch leaves something behind to
  // explain itself — and it announces the ending like every other closed run.
  it('closes every run it opened when the batch is refused', async () => {
    const journal = createMemoryJournal()
    const platform = batchingLauncher({ refusesBatch: true })
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher })

    const thrown = await startDurableWorkflows({
      launcher: platform.launcher,
      definition: definitionOf(ship) as never,
      inputs: [{ mark: 'A' }, { mark: 'B' }],
      ctx: flow.runtime,
    }).catch((error: unknown) => error)

    expect((thrown as Error).message).toContain('the platform is unavailable')
    expect(journal.runs.map((run) => run.status)).toEqual(['failed', 'failed'])
    expect(journal.outbox.map((event) => event.type)).toEqual([
      'workflow.compensated',
      'workflow.compensated',
    ])
  })

  it('refuses an input the schema will not take, before opening anything', async () => {
    const journal = createMemoryJournal()
    const platform = batchingLauncher()
    const markSchema: StandardSchemaV1<{ mark: string }, { mark: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) =>
          typeof (value as { mark?: unknown }).mark === 'string'
            ? { value: value as { mark: string } }
            : { issues: [{ message: 'mark must be a string' }] },
      },
    }

    const typed = saga('thing.ship-typed', { durable: true, input: markSchema }, async (input) =>
      step('ship', async () => input.mark),
    )
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher })

    await startDurableWorkflows({
      launcher: platform.launcher,
      definition: definitionOf(typed) as never,
      inputs: [{ mark: 'A' }, { mark: 7 }],
      ctx: flow.runtime,
    }).catch(() => undefined)

    expect(journal.runs).toEqual([])
    expect(platform.created).toEqual([])
  })
})

describe('starting many from the definition', () => {
  it('is startAll on a durable saga', async () => {
    const journal = createMemoryJournal()
    const platform = batchingLauncher()
    const flow = sagaflow({ journal: journal.journal, launcher: platform.launcher })

    const started = await ship.startAll([{ mark: 'X' }, { mark: 'Y' }], flow)

    expect(started.map((one) => one.deduplicated)).toEqual([false, false])
    expect(platform.batches).toEqual([2])
  })
})
