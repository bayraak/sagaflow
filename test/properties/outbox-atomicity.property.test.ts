import { describe, expect, it } from 'bun:test'

import * as fc from 'fast-check'

import { defineWorkflow } from '../../src/define.js'
import {
  envelopeId,
  lifecycleEvents,
  type EventEnvelope,
  type RunJournal,
  type RunStatus,
  type StepCall,
  type StepContext,
  type WorkflowHandle,
} from '../../src/index.js'
import { type MemoryFinishRow, type MemoryJournal, type MemoryRunRow } from '../../src/memory/index'
import { createTestRuntime, type TestRuntime } from '../helpers/runtime'
import { markInput } from '../helpers/steps'
import { assertProperty, createCoverage } from './harness'

/*
 * Guarantee 2. A run is `completed` if and only if its events are queued. The write that closes
 * the run and the write that queues what it emitted are one act, so "completed, and its audit
 * trail lost" is not a state this library can reach — whatever gives out, and wherever it gives
 * out.
 *
 * The scenarios break the journal at every point a run touches it: a step record, the finish
 * itself, the outbox write inside the finish, the note that says the events were delivered. The
 * sink is allowed to refuse too, because a queue being down must not move the run's status by
 * one letter.
 */

/** What the tables say afterwards. The whole guarantee is a statement about these three. */
type Tables = Pick<MemoryJournal, 'finishes' | 'outbox' | 'runs'>

const closedBadly: readonly string[] = ['cancelled', 'compensated', 'failed']

/**
 * The guarantee, as a check that refuses a set of tables it should never be shown. Written as a
 * refusal rather than as an expectation so that the same code judges a generated run and the
 * hand-built states below, and so a violation says which run and which claim.
 */
const assertAtomic = (tables: Tables): void => {
  for (const run of tables.runs) {
    const queued = tables.outbox.filter((envelope) => envelope.runId === run.id)
    const announced = (type: string): number =>
      queued.filter((envelope) => envelope.type === type).length
    const refuse = (why: string): never => {
      throw new Error(`run ${run.id} is ${run.status} but ${why}`)
    }

    const completions = announced(lifecycleEvents.completed)
    const undoings = announced(lifecycleEvents.compensated)

    if (run.status === 'completed') {
      if (completions !== 1) refuse(`${completions} completion events are queued`)

      // Not just the announcement: everything the run held until it closed went into the same
      // write, so all of it is queued or the run is not completed.
      const carried = tables.finishes.find((finish) => finish.runId === run.id)?.events ?? []
      const lost = carried.filter((event) => !queued.some((envelope) => envelope.id === event.id))
      if (lost.length > 0) refuse(`${lost.length} of the events it closed with are not queued`)
    } else if (completions > 0) {
      refuse('its completion event is queued')
    }

    if (run.status === 'running' && queued.length > 0) {
      refuse(`${queued.length} of its events are already queued`)
    }

    const closed = closedBadly.includes(run.status)
    if (closed && undoings !== 1) refuse(`${undoings} compensation events are queued`)
    if (!closed && undoings > 0) refuse('a compensation event is queued')
  }
}

const aRun = (status: RunStatus, id = 'run_1'): MemoryRunRow => ({
  id,
  tenantId: 'acme',
  name: 'property.outbox',
  execution: 'inline',
  idempotencyKey: null,
  parentRunId: null,
  input: {},
  status,
  cancelRequested: false,
  startedAt: 0,
})

const anEnvelope = (ordinal: number, type: string, runId = 'run_1'): EventEnvelope => ({
  id: envelopeId(runId, ordinal),
  type,
  payload: {},
  tenantId: 'acme',
  actor: null,
  runId,
  occurredAt: ordinal,
})

const aFinish = (status: MemoryFinishRow['status'], events: EventEnvelope[]): MemoryFinishRow => ({
  runId: 'run_1',
  status,
  events,
})

const issued = anEnvelope(0, 'invoice.issued')
const completion = anEnvelope(1, lifecycleEvents.completed)
const undone = anEnvelope(0, lifecycleEvents.compensated)

/*
 * Six tables that must never exist. Each is a way the outbox and the run record could disagree,
 * and the check has to refuse every one of them — otherwise the property below would accept a
 * broken engine and say so cheerfully for years.
 */
describe('the check refuses every way a run and its outbox can disagree', () => {
  it('accepts a run that closed and queued what it emitted', () => {
    expect(() =>
      assertAtomic({
        runs: [aRun('completed')],
        outbox: [issued, completion],
        finishes: [aFinish('completed', [issued, completion])],
      }),
    ).not.toThrow()
  })

  it('refuses a completed run with nothing queued', () => {
    expect(() =>
      assertAtomic({
        runs: [aRun('completed')],
        outbox: [],
        finishes: [aFinish('completed', [issued, completion])],
      }),
    ).toThrow()
  })

  it('refuses a completed run that queued only some of what it emitted', () => {
    expect(() =>
      assertAtomic({
        runs: [aRun('completed')],
        outbox: [completion],
        finishes: [aFinish('completed', [issued, completion])],
      }),
    ).toThrow()
  })

  it('refuses a run still open whose events are already queued', () => {
    expect(() =>
      assertAtomic({ runs: [aRun('running')], outbox: [issued], finishes: [] }),
    ).toThrow()
  })

  it('refuses a compensated run carrying a completion event', () => {
    expect(() =>
      assertAtomic({
        runs: [aRun('compensated')],
        outbox: [completion],
        finishes: [aFinish('compensated', [completion])],
      }),
    ).toThrow()
  })

  it('refuses a run that closed badly and announced nothing', () => {
    expect(() =>
      assertAtomic({ runs: [aRun('failed')], outbox: [], finishes: [aFinish('failed', [])] }),
    ).toThrow()
  })

  it('refuses a run that announced itself twice', () => {
    expect(() =>
      assertAtomic({
        runs: [aRun('completed')],
        outbox: [completion, anEnvelope(2, lifecycleEvents.completed)],
        finishes: [aFinish('completed', [completion])],
      }),
    ).toThrow()
  })

  it('refuses a run undone twice over', () => {
    expect(() =>
      assertAtomic({
        runs: [aRun('failed')],
        outbox: [undone, anEnvelope(1, lifecycleEvents.compensated)],
        finishes: [aFinish('failed', [undone])],
      }),
    ).toThrow()
  })
})

type Injection =
  | { kind: 'finishRun' }
  | { kind: 'markEventsDispatched' }
  | { kind: 'none' }
  | { kind: 'outbox' }
  | { kind: 'recordStep'; at: number }

type Scenario = {
  steps: { emits: boolean; refusesUndo: boolean }[]
  failAt: null | number
  bodyEmits: boolean
  injection: Injection
  sinkRefuses: boolean
}

/**
 * The journal, with one call somewhere in the middle of a run made to give out. The occurrence
 * matters as much as the method: refusing the first step record and refusing the third are
 * different crashes, and the guarantee has to survive both.
 */
const refusing = (
  journal: RunJournal,
  method: 'finishRun' | 'markEventsDispatched' | 'recordStep',
  at: number,
): RunJournal => {
  let seen = 0

  return {
    ...journal,
    [method]: async (params: Record<string, unknown>) => {
      const occurrence = seen
      seen += 1
      if (occurrence === at) throw new Error(`the journal refused ${method}`)

      return journal[method](params as never)
    },
  }
}

const stepName = (index: number): string => `s${index}`

const observed = async (scenario: Scenario): Promise<Tables> => {
  const harness = createTestRuntime({ sinkRefuses: scenario.sinkRefuses })
  if (scenario.injection.kind === 'outbox') harness.breakOutboxWrites()

  const call = (
    wf: WorkflowHandle<TestRuntime>,
    step: { emits: boolean; refusesUndo: boolean },
    index: number,
  ): StepCall<{ seen: string }> =>
    wf.step(
      stepName(index),
      async (stepCtx: StepContext<TestRuntime>) => {
        if (step.emits) stepCtx.emit('invoice.issued', { invoiceId: stepName(index), total: index })
        if (index === (scenario.failAt ?? 0) - 1) throw new Error(`${stepName(index)} refused`)

        return { seen: stepName(index) }
      },
      {
        undo: async () => {
          // An undo that refuses is what turns a compensated run into a failed one, and a
          // failed run still owes the table its announcement.
          if (step.refusesUndo) throw new Error(`${stepName(index)} could not be undone`)
        },
      },
    )

  const workflow = defineWorkflow(
    { name: 'property.outbox', input: markInput, execution: 'inline' },
    async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      if (scenario.bodyEmits) wf.emit('invoice.voided', { invoiceId: 'body' })

      for (const [index, step] of scenario.steps.entries()) await call(wf, step, index)
    },
  )

  const journal =
    scenario.injection.kind === 'recordStep'
      ? refusing(harness.ctx.journal, 'recordStep', scenario.injection.at)
      : scenario.injection.kind === 'markEventsDispatched'
        ? refusing(harness.ctx.journal, 'markEventsDispatched', 0)
        : scenario.injection.kind === 'finishRun'
          ? refusing(harness.ctx.journal, 'finishRun', 0)
          : harness.ctx.journal

  // Anything at all may come back out of a run whose journal gave out — a saga failure, the
  // journal's own refusal, or a perfectly ordinary answer. None of that is the guarantee; what
  // the tables say afterwards is.
  await workflow
    .run({ input: { mark: 'x' }, ctx: { ...harness.ctx, journal } })
    .catch(() => undefined)

  return harness
}

const scenario: fc.Arbitrary<Scenario> = fc
  .array(fc.record({ emits: fc.boolean(), refusesUndo: fc.boolean() }), {
    minLength: 1,
    maxLength: 5,
  })
  .chain((steps) =>
    fc.record({
      steps: fc.constant(steps),
      failAt: fc.option(fc.integer({ min: 1, max: steps.length }), { nil: null }),
      bodyEmits: fc.boolean(),
      sinkRefuses: fc.boolean(),
      injection: fc.oneof(
        fc.constant<Injection>({ kind: 'none' }),
        fc.nat({ max: 9 }).map<Injection>((at) => ({ kind: 'recordStep', at })),
        fc.constant<Injection>({ kind: 'finishRun' }),
        fc.constant<Injection>({ kind: 'markEventsDispatched' }),
        fc.constant<Injection>({ kind: 'outbox' }),
      ),
    }),
  )

describe('outbox atomicity', () => {
  it('holds however the journal gives out', async () => {
    const coverage = createCoverage()

    await assertProperty(
      'a run is completed if and only if its events are queued',
      fc.asyncProperty(scenario, async (generated) => {
        const tables = await observed(generated)
        const run = tables.runs[0]
        coverage.saw(`${run?.status ?? 'no run'}/${tables.outbox.length > 0 ? 'queued' : 'empty'}`)
        coverage.saw(`broke ${generated.injection.kind}`)

        assertAtomic(tables)
      }),
    )

    // Green because nothing interesting happened is the failure mode a property like this one
    // dies of, so the four states a run can be left in and all five injection points have to
    // have come up.
    coverage.reached(
      'completed/queued',
      'compensated/queued',
      'failed/queued',
      'running/empty',
      'broke none',
      'broke recordStep',
      'broke finishRun',
      'broke markEventsDispatched',
      'broke outbox',
    )
  })
})
