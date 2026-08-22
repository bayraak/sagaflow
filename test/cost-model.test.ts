import { describe, expect, it } from 'bun:test'

import {
  defineWorkflow,
  dispatchEvents,
  executeDurable,
  type EventEnvelope,
  type RunJournal,
  type WorkflowHandle,
} from '../src/index'
import { createMemoryJournal, createMemorySink } from '../src/memory/index'
import { createSqlJournal, type SqlDriver, type SqlStatement } from '../src/sql/index'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

/*
 * What the engine costs, counted rather than felt.
 *
 * These numbers are the cost model. Every one of them is a design decision somebody made on
 * purpose — a round trip per step is a forensics property, not an oversight; one write to close
 * a run is an atomicity property, not a saving. A change to any number here is a change to the
 * design, and it should arrive as a deliberate edit to this file with a reason attached, never
 * as drift somebody notices six months later in a flame graph.
 */

const countingJournal = (journal: RunJournal): { journal: RunJournal; calls: string[] } => {
  const calls: string[] = []
  const counted = Object.fromEntries(
    Object.entries(journal).map(([name, method]) => [
      name,
      (params: never) => {
        calls.push(name)

        return (method as (given: never) => unknown)(params)
      },
    ]),
  ) as RunJournal

  return { journal: counted, calls }
}

const threeSteps = defineWorkflow(
  { name: 'cost.three-steps', input: markInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
    await wf.step(markStep('first'), input)
    await wf.step(markStep('second'), input)
    await wf.step(markStep('third'), input)
  },
)

describe('what a run costs the journal', () => {
  // One insert to open the run, one write per step so a crashed isolate still leaves a partial
  // trail somebody can read, and one write to close it. The per-step write is the forensics
  // property: buffering them would be cheaper and would lose exactly the thing the trail is
  // for.
  it('is five round trips for a three-step inline run with no sink', async () => {
    const memory = createMemoryJournal()
    const counted = countingJournal(memory.journal)

    await threeSteps.run({
      input: { mark: 'x' },
      ctx: { tenantId: 'acme', journal: counted.journal, invocations: [] },
    })

    expect(counted.calls).toEqual([
      'insertRun',
      'recordStep',
      'recordStep',
      'recordStep',
      'finishRun',
    ])
  })

  it('is six when a sink is there to drain to', async () => {
    const memory = createMemoryJournal()
    const counted = countingJournal(memory.journal)
    const { sink } = createMemorySink()

    await threeSteps.run({
      input: { mark: 'x' },
      ctx: { tenantId: 'acme', journal: counted.journal, events: sink, invocations: [] },
    })

    expect(counted.calls).toEqual([
      'insertRun',
      'recordStep',
      'recordStep',
      'recordStep',
      'finishRun',
      'markEventsDispatched',
    ])
  })

  // Cancellation is free because it rides home on a write the engine was already making.
  it('costs nothing extra to notice a cancellation', async () => {
    const memory = createMemoryJournal()
    const counted = countingJournal(memory.journal)

    await threeSteps.run({
      input: { mark: 'x' },
      ctx: { tenantId: 'acme', journal: counted.journal, invocations: [] },
    })

    expect(counted.calls.filter((call) => call === 'requestCancellation')).toEqual([])
  })
})

const countingDriver = (): { driver: SqlDriver; batches: number[] } => {
  const batches: number[] = []

  return {
    batches,
    driver: {
      run: async () => ({ changes: 1 }),
      all: async () => [],
      batch: async (statements: SqlStatement[]) => {
        batches.push(statements.length)

        return statements.map(() => [])
      },
    },
  }
}

describe('what closing a run costs the database', () => {
  // One update to close the run and one insert per event, in ONE batch — that is the atomicity
  // the whole outbox rests on. Two batches would make "completed, audit trail lost" a state
  // this library can produce.
  it('is one batch of one update plus one row per event', async () => {
    const counting = countingDriver()
    const journal = createSqlJournal(counting.driver)
    const events: EventEnvelope[] = [0, 1, 2].map((ordinal) => ({
      id: `run_1:${ordinal}`,
      type: 'invoice.issued',
      payload: {},
      tenantId: 'acme',
      actor: null,
      runId: 'run_1',
      occurredAt: 10 + ordinal,
    }))

    await journal.finishRun({ tenantId: 'acme', runId: 'run_1', status: 'completed', events })

    expect(counting.batches).toEqual([4])
  })

  it('is one batch of one statement when the run emitted nothing', async () => {
    const counting = countingDriver()
    const journal = createSqlJournal(counting.driver)

    await journal.finishRun({ tenantId: 'acme', runId: 'run_1', status: 'completed' })

    expect(counting.batches).toEqual([1])
  })

  // Two statements per step would be two round trips. The cancellation flag comes back with the
  // step record instead.
  it('is one batch of two statements to record a step and read the cancel flag', async () => {
    const counting = countingDriver()
    const journal = createSqlJournal(counting.driver)

    await journal.recordStep({
      tenantId: 'acme',
      runId: 'run_1',
      seq: 0,
      name: 'charge',
      status: 'completed',
      attempt: 1,
    })

    expect(counting.batches).toEqual([2])
  })
})

describe('what delivery costs', () => {
  it('is one send per hundred events', async () => {
    const { sink, batches } = createMemorySink()
    const envelopes: EventEnvelope[] = Array.from({ length: 250 }, (_unused, ordinal) => ({
      id: `run_1:${ordinal}`,
      type: 'invoice.issued',
      payload: {},
      tenantId: 'acme',
      actor: null,
      runId: 'run_1',
      occurredAt: ordinal,
    }))

    const delivered = await dispatchEvents({
      sink,
      envelopes,
      markDispatched: async () => undefined,
    })

    expect(delivered).toBe(250)
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50])
  })
})

describe('what a re-invocation costs', () => {
  // Nothing. Which is the point of the whole re-invocation design: the body runs again, and not
  // one thing it already did runs again with it.
  it('re-executes no step and re-runs no finish', async () => {
    const harness = createTestRuntime()
    const platform = createCachingPrimitive()

    const workflow = defineWorkflow(
      { name: 'cost.replayed', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('first'), input)
        await wf.step(markStep('second'), input)
      },
    )

    for (let invocation = 0; invocation < 3; invocation += 1) {
      await executeDurable(
        workflow,
        { runId: 'run_replayed', input: { mark: 'x' } },
        harness.ctx,
        platform.primitive(),
      )
    }

    expect(platform.executed).toEqual(['first', 'second', 'finish-run', 'emit-events'])
    expect(harness.invocations).toEqual(['invoke:first', 'invoke:second'])
    expect(harness.finishes).toHaveLength(1)
  })
})

describe('what unwinding costs', () => {
  // Exactly the steps that completed, and not the one that failed. Everybody's first attempt at
  // a saga undoes the failed step too.
  it('is one undo per completed step before the failure', async () => {
    for (const failAt of [1, 2, 3, 4, 5]) {
      const harness = createTestRuntime()
      const names = ['a', 'b', 'c', 'd', 'e']

      const workflow = defineWorkflow(
        { name: `cost.fail-at-${failAt}`, input: markInput, execution: 'inline' },
        async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
          for (const [index, name] of names.entries()) {
            await wf.step(markStep(name, { fails: index === failAt - 1 }), input)
          }
        },
      )

      await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

      const undone = harness.invocations.filter((entry) => entry.startsWith('compensate:'))

      expect(undone).toHaveLength(failAt - 1)
      expect(undone).toEqual(
        names
          .slice(0, failAt - 1)
          .toReversed()
          .map((name) => `compensate:${name}`),
      )
    }
  })

  it('never undoes the step that failed', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'cost.never-undo-the-failure', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('a'), input)
        await wf.step(markStep('b', { fails: true }), input)
      },
    )

    await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).catch(() => undefined)

    expect(harness.invocations).toEqual(['invoke:a', 'invoke:b', 'compensate:a'])
  })
})
