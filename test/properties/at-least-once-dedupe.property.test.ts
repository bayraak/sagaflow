import { describe, expect, it } from 'bun:test'

import * as fc from 'fast-check'

import { defineWorkflow } from '../../src/define.js'
import {
  sweepEventOutbox,
  type EventEnvelope,
  type EventSink,
  type RunJournal,
  type StepCall,
  type StepContext,
  type WorkflowHandle,
} from '../../src/index.js'
import { createMemoryJournal } from '../../src/memory/index'
import { testEventSchemas } from '../helpers/events'
import { type TestRuntime } from '../helpers/runtime'
import { markInput } from '../helpers/steps'
import { assertProperty, createCoverage } from './harness'

/*
 * Guarantee 4. Delivery is at least once and envelopes carry an id, so a consumer that
 * remembers ids sees each event exactly once. Between the drain a run does for itself and the
 * sweep a cron does for whatever the drain could not finish, nothing durably queued is ever
 * lost.
 *
 * Both halves of the drain are allowed to give out independently, because they fail
 * differently. A queue that refuses a batch means the events did not travel and the rows stay
 * on the table. A delivery note that does not get written means the events DID travel and the
 * rows still look undelivered — so the next sweep sends them again. That second case is the
 * one that makes duplicates ordinary rather than exotic, and it is the case the id exists for.
 *
 * Nothing here is exactly-once, and the check is careful not to accidentally test for it: the
 * transport is expected to repeat itself, and one of the cases below exists to make sure a
 * repeat is not treated as a fault.
 */

type Delivery = {
  /** What the runs durably queued. */
  queued: string[]
  /** Every id the transport handed over, repeats included. */
  transported: string[]
  /** What a consumer keyed on the envelope id accepted. */
  handled: string[]
  /** What was still sitting on the table when the sweeps ran out of work. */
  stranded: string[]
}

/** The guarantee, as a check that refuses a delivery it should never be shown. */
const assertDelivered = (delivery: Delivery): void => {
  const twice = duplicates(delivery.handled)
  if (twice.length > 0) throw new Error(`the consumer saw an event twice: ${twice.join(', ')}`)

  const lost = delivery.queued.filter((id) => !delivery.handled.includes(id))
  if (lost.length > 0) throw new Error(`queued but never delivered: ${lost.join(', ')}`)

  const invented = delivery.handled.filter((id) => !delivery.queued.includes(id))
  if (invented.length > 0) throw new Error(`delivered but never queued: ${invented.join(', ')}`)

  if (delivery.stranded.length > 0) {
    throw new Error(
      `left on the table with nothing left to send them: ${delivery.stranded.join(', ')}`,
    )
  }

  // Deliberately an inequality. Delivery is at least once, so the transport carrying more than
  // the consumer accepted is the design working, not a fault — and only the other direction is
  // impossible.
  if (delivery.transported.length < delivery.handled.length) {
    throw new Error(
      `the consumer handled ${delivery.handled.length} events out of ${delivery.transported.length} delivered`,
    )
  }
}

const clean: Delivery = {
  queued: ['run_1:0', 'run_1:1'],
  transported: ['run_1:0', 'run_1:1'],
  handled: ['run_1:0', 'run_1:1'],
  stranded: [],
}

describe('the check refuses every way a delivery can lose or repeat an event', () => {
  it('accepts a delivery in which everything queued was handled once', () => {
    expect(() => assertDelivered(clean)).not.toThrow()
  })

  // The point of the whole design. If this threw, the check would be testing for exactly-once
  // delivery, which nothing anywhere provides.
  it('accepts a transport that sent the same batch three times', () => {
    expect(() =>
      assertDelivered({
        ...clean,
        transported: ['run_1:0', 'run_1:1', 'run_1:0', 'run_1:1', 'run_1:0', 'run_1:1'],
      }),
    ).not.toThrow()
  })

  it('refuses a consumer that saw one id twice', () => {
    expect(() =>
      assertDelivered({ ...clean, handled: ['run_1:0', 'run_1:1', 'run_1:0'] }),
    ).toThrow()
  })

  it('refuses a queued event that was never handled', () => {
    expect(() => assertDelivered({ ...clean, handled: ['run_1:0'] })).toThrow()
  })

  it('refuses a handled event that was never queued', () => {
    expect(() =>
      assertDelivered({ ...clean, handled: ['run_1:0', 'run_1:1', 'run_9:0'] }),
    ).toThrow()
  })

  it('refuses events left on the table after the sweeps ran out of work', () => {
    expect(() => assertDelivered({ ...clean, stranded: ['run_1:1'] })).toThrow()
  })

  it('refuses a transport that delivered less than the consumer somehow handled', () => {
    expect(() => assertDelivered({ ...clean, transported: ['run_1:0'] })).toThrow()
  })
})

type Scenario = {
  runs: { emits: number; fails: boolean; tenant: string }[]
  queueRefuses: boolean[]
  sendsTwice: boolean[]
  noteRefuses: boolean[]
}

const duplicates = (values: string[]): string[] =>
  values.filter((value, index) => values.indexOf(value) !== index)

const observed = async (scenario: Scenario): Promise<Delivery> => {
  const memory = createMemoryJournal()
  const recognised = new Set<string>()
  const handled: string[] = []
  const transported: string[] = []
  let sends = 0
  let notes = 0

  const consume = (envelopes: EventEnvelope[]): void => {
    for (const envelope of envelopes) {
      transported.push(envelope.id)
      if (recognised.has(envelope.id)) continue

      recognised.add(envelope.id)
      handled.push(envelope.id)
    }
  }

  const sink: EventSink = {
    sendBatch: async (messages) => {
      const attempt = sends
      sends += 1
      if (scenario.queueRefuses[attempt] === true) throw new Error('the queue is unreachable')

      const bodies = messages.map((message) => message.body)
      consume(bodies)
      // At-least-once from the other side: the transport itself is allowed to hand the same
      // batch over again, which is what a queue with no acknowledgement does.
      if (scenario.sendsTwice[attempt] === true) consume(bodies)
    },
  }

  const journal: RunJournal = {
    ...memory.journal,
    markEventsDispatched: async (params) => {
      const attempt = notes
      notes += 1
      if (scenario.noteRefuses[attempt] === true) throw new Error('the note was not written')

      return memory.journal.markEventsDispatched(params)
    },
  }

  for (const [index, run] of scenario.runs.entries()) {
    const workflow = defineWorkflow(
      { name: `property.delivery-${index}`, input: markInput, execution: 'inline' },
      async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        const call: StepCall<{ seen: string }> = wf.step(
          'announce',
          async (stepCtx: StepContext<TestRuntime>) => {
            for (let emitted = 0; emitted < run.emits; emitted += 1) {
              stepCtx.emit('invoice.issued', { invoiceId: `r${index}e${emitted}`, total: emitted })
            }

            return { seen: `r${index}` }
          },
          { undo: async () => undefined },
        )
        await call

        if (run.fails) throw new Error(`run ${index} refused`)
      },
    )

    const ctx: TestRuntime = {
      tenantId: run.tenant,
      actor: 'tester',
      journal,
      events: sink,
      eventSchemas: testEventSchemas,
      invocations: [],
    }

    await workflow.run({ input: { mark: 'x' }, ctx }).catch(() => undefined)
  }

  const outstanding = async (): Promise<string[]> =>
    (await memory.journal.listUndispatchedEvents({ before: Date.now() + 1, limit: 500 })).map(
      (row) => row.envelope.id,
    )

  // A cron that fell over runs again on the next tick. The generated refusals are finite, so
  // this terminates; the bound is only here so a bug cannot turn a test run into a hang.
  for (let tick = 0; tick < 20; tick += 1) {
    if ((await outstanding()).length === 0) break

    await sweepEventOutbox({ journal, sink, olderThanMs: 0, now: Date.now() + 1 }).catch(
      () => undefined,
    )
  }

  return {
    queued: memory.outbox.map((envelope) => envelope.id),
    transported,
    handled,
    stranded: await outstanding(),
  }
}

const scenario: fc.Arbitrary<Scenario> = fc.record({
  runs: fc.array(
    fc.record({
      emits: fc.integer({ min: 0, max: 3 }),
      fails: fc.boolean(),
      tenant: fc.constantFrom('acme', 'globex'),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  queueRefuses: fc.array(fc.boolean(), { maxLength: 6 }),
  sendsTwice: fc.array(fc.boolean(), { maxLength: 6 }),
  noteRefuses: fc.array(fc.boolean(), { maxLength: 6 }),
})

describe('at-least-once delivery with dedupe', () => {
  it('holds however the queue and its notes give out', async () => {
    const coverage = createCoverage()

    await assertProperty(
      'every queued envelope reaches a deduping consumer exactly once',
      fc.asyncProperty(scenario, async (generated) => {
        const delivery = await observed(generated)
        coverage.saw(
          duplicates(delivery.transported).length > 0
            ? 'the transport repeated itself'
            : 'nothing was sent twice',
        )
        coverage.saw(generated.runs.some((run) => run.fails) ? 'a run was undone' : 'all completed')
        coverage.saw(
          new Set(generated.runs.map((run) => run.tenant)).size > 1
            ? 'more than one tenant'
            : 'one tenant',
        )
        coverage.saw(generated.noteRefuses.includes(true) ? 'a note was lost' : 'every note landed')
        coverage.saw(generated.queueRefuses.includes(true) ? 'the queue refused' : 'the queue held')

        assertDelivered(delivery)
      }),
    )

    coverage.reached(
      'the transport repeated itself',
      'nothing was sent twice',
      'a run was undone',
      'all completed',
      'more than one tenant',
      'one tenant',
      'a note was lost',
      'every note landed',
      'the queue refused',
      'the queue held',
    )
  })
})
