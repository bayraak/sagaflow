import { describe, expect, it } from 'bun:test'

import { executeDurable, saga, sagaflow, step } from 'sagaflow-js'
import { z } from 'zod'

import { createMemoryJournal } from '../src/memory/index'
import { createCachingPrimitive } from './helpers/primitive'

/*
 * An event is a fact about the run, and a run knows what it did — so the run declares it, in the
 * same place it declares its name, its input schema and its idempotency rule. A body that reaches
 * for an `emit` verb halfway through is announcing something that has not happened yet: the run
 * can still fail after that line, and the whole point of the outbox is that nothing is announced
 * until the run is a fact.
 *
 * The engine already had this for a step and for an action. This is the same rule one level up.
 */
const schemas = {
  'booking.created': z.object({ seat: z.string().min(1) }),
  'booking.charged': z.object({ seat: z.string().min(1), amount: z.number() }),
}

const book = saga(
  'booking.create',
  {
    input: z.object({ seat: z.string().min(1) }),
    // Annotated because this body takes its parameter from the input schema, so its return
    // type is not available to TypeScript at the point this callback is typed.
    announce: (output: { seat: string; amount: number }) => [
      'booking.created',
      { seat: output.seat },
    ],
  },
  async (input) => {
    await step('reserve', () => ({ id: input.seat }))

    return { seat: input.seat, amount: 10 }
  },
)

describe('what a run announces when it completes', () => {
  it('puts the declared event in the outbox', async () => {
    const memory = createMemoryJournal()
    const flow = sagaflow({
      journal: memory.journal,
      eventSchemas: schemas,
      warn: () => undefined,
    })

    await book({ seat: '12A' }, flow)

    expect(memory.outbox.map((envelope) => envelope.type)).toEqual([
      'booking.created',
      'workflow.completed',
    ])
    expect(memory.outbox[0]?.payload).toEqual({ seat: '12A' })
  })

  it('announces several when the run did several things worth saying', async () => {
    const memory = createMemoryJournal()
    const both = saga(
      'booking.create-both',
      {
        announce: (output) => [
          ['booking.created', { seat: output.seat }],
          ['booking.charged', { seat: output.seat, amount: output.amount }],
        ],
      },
      async (input: { seat: string }) => ({ seat: input.seat, amount: 10 }),
    )

    await both(
      { seat: '12A' },
      sagaflow({ journal: memory.journal, eventSchemas: schemas, warn: () => undefined }),
    )

    expect(memory.outbox.map((envelope) => envelope.type)).toEqual([
      'booking.created',
      'booking.charged',
      'workflow.completed',
    ])
  })

  it('announces nothing when the rule says there is nothing to say', async () => {
    const memory = createMemoryJournal()
    const quiet = saga(
      'booking.quiet',
      { announce: () => null },
      async (input: { seat: string }) => ({ seat: input.seat }),
    )

    await quiet(
      { seat: '12A' },
      sagaflow({ journal: memory.journal, eventSchemas: schemas, warn: () => undefined }),
    )

    expect(memory.outbox.map((envelope) => envelope.type)).toEqual(['workflow.completed'])
  })

  it('announces nothing at all when the run was undone', async () => {
    const memory = createMemoryJournal()
    const refuses = saga(
      'booking.refuses',
      {
        announce: (output) => ['booking.created', { seat: output.seat }],
      },
      async (input: { seat: string }) => {
        await step('reserve', () => ({ id: input.seat }))
        await step('charge', () => {
          throw new Error('the card was declined')
        })

        return { seat: input.seat }
      },
    )

    await refuses(
      { seat: '12A' },
      sagaflow({ journal: memory.journal, eventSchemas: schemas, warn: () => undefined }),
    ).catch(() => undefined)

    expect(memory.outbox.map((envelope) => envelope.type)).toEqual(['workflow.compensated'])
  })

  it('refuses a payload the schema does not accept, and undoes the run', async () => {
    const memory = createMemoryJournal()
    const wrong = saga(
      'booking.wrong',
      { announce: () => ['booking.created', { seat: '' }] },
      async (input: { seat: string }) => ({ seat: input.seat }),
    )

    const thrown = await wrong(
      { seat: '12A' },
      sagaflow({ journal: memory.journal, eventSchemas: schemas, warn: () => undefined }),
    ).catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(Error)
    expect(memory.runs[0]?.status).toBe('compensated')
    expect(memory.outbox.map((envelope) => envelope.type)).toEqual(['workflow.compensated'])
  })
})

describe('what a durable run announces when it is invoked twice', () => {
  it('announces once, under one id', async () => {
    const memory = createMemoryJournal()
    const ship = saga(
      'booking.ship',
      {
        input: z.object({ seat: z.string().min(1) }),
        durable: true,
        announce: (output: { seat: string }) => ['booking.created', { seat: output.seat }],
      },
      async (input) => {
        await step('reserve', () => ({ id: input.seat }))

        return { seat: input.seat }
      },
    )

    const ctx = {
      tenantId: 'tenant_local',
      actor: null,
      journal: memory.journal,
      eventSchemas: schemas,
    }
    const runId = await memory.journal.insertRun({
      tenantId: 'tenant_local',
      name: 'booking.ship',
      execution: 'durable',
      idempotencyKey: null,
      input: { seat: '12A' },
    })
    const platform = createCachingPrimitive({ crashOnce: ['finish-run'] })
    const definition = (await import('../src/saga.js')).definitionOf(ship)
    if (!definition) throw new Error('the durable saga has no definition')

    await executeDurable(
      definition,
      { runId, input: { seat: '12A' } },
      ctx as never,
      platform.primitive(),
    ).catch(() => undefined)
    await executeDurable(
      definition,
      { runId, input: { seat: '12A' } },
      ctx as never,
      platform.primitive(),
    )

    expect(memory.outbox.map((envelope) => envelope.type)).toEqual([
      'booking.created',
      'workflow.completed',
    ])
    expect(new Set(memory.outbox.map((envelope) => envelope.id)).size).toBe(2)
  })
})
