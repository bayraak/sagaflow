import { describe, expect, it } from 'bun:test'

import * as fc from 'fast-check'

import { defineWorkflow } from '../../src/define.js'
import { SagaError, type StepCall, type StepContext, type WorkflowHandle } from '../../src/index.js'
import { createTestRuntime, type TestRuntime } from '../helpers/runtime'
import { markInput } from '../helpers/steps'
import { assertProperty, createCoverage } from './harness'

/*
 * Guarantee 1. Fail a run at any step and exactly the steps that finished are undone: each undo
 * attempted once, in the reverse of the order the steps STARTED, the failed step never among
 * them. The run is written down as `compensated` only if every undo came back; one refusal makes
 * it `failed`, because `compensated` is a claim that the tenant was left whole.
 *
 * Half the scenarios run their steps concurrently through a relay that makes each step finish
 * only after the one behind it — so the run completes its steps in the exact reverse of the
 * order it started them. Sequentially the two orders are the same and "reverse start order" is
 * an unfalsifiable claim; under the relay they are opposites, and the specification below is
 * choosing one of them on every trial.
 */

type StepSpec = { undoable: boolean; refusesUndo: boolean }
type Scenario = { steps: StepSpec[]; failAt: number; concurrent: boolean }

/** What the run did, as anybody watching from outside can see it. */
type Trace = {
  invoked: string[]
  undone: string[]
  outcome: string
  recorded: string
}

const stepName = (index: number): string => `s${index}`

/**
 * The steps that got to run at all. Sequentially the failure stops the body, so it is the ones
 * up to and including it; concurrently every step was already started before the failure
 * happened, and the engine settles all of them before it unwinds anything.
 */
const reached = ({ steps, failAt, concurrent }: Scenario): { step: StepSpec; index: number }[] =>
  steps.map((step, index) => ({ step, index })).filter(({ index }) => concurrent || index < failAt)

/**
 * The guarantee, written as a function: given a scenario, the one trace the engine is allowed
 * to produce.
 */
const specified = (scenario: Scenario): Trace => {
  const failed = scenario.failAt - 1
  const standing = reached(scenario).filter(({ step, index }) => index !== failed && step.undoable)
  const outcome = standing.some(({ step }) => step.refusesUndo) ? 'failed' : 'compensated'

  return {
    invoked: reached(scenario).map(({ index }) => stepName(index)),
    undone: standing.toReversed().map(({ index }) => stepName(index)),
    outcome,
    recorded: outcome,
  }
}

/**
 * A chain of one-shot gates. Step `n` releases gate `n - 1`, so the last step to start is the
 * first to finish and the first to start is the last.
 */
const createRelay = (count: number) => {
  const releases: (() => void)[] = []
  const gates = Array.from(
    { length: count },
    () => new Promise<void>((resolve) => releases.push(resolve)),
  )

  return {
    reach: async (index: number): Promise<void> => {
      await gates[index]
    },
    release: (index: number): void => releases[index]?.(),
  }
}

const observed = async (scenario: Scenario): Promise<Trace> => {
  const harness = createTestRuntime()
  const relay = createRelay(scenario.steps.length)
  const last = scenario.steps.length - 1

  const call = (
    wf: WorkflowHandle<TestRuntime>,
    spec: StepSpec,
    index: number,
  ): StepCall<{ seen: string }> =>
    wf.step(
      stepName(index),
      async (stepCtx: StepContext<TestRuntime>) => {
        stepCtx.invocations.push(`invoke:${stepName(index)}`)
        if (scenario.concurrent && index < last) await relay.reach(index)
        // Released before the refusal, so the step that fails still lets the chain behind it
        // finish rather than leaving the run waiting on a step that will never come back.
        relay.release(index - 1)
        if (index === scenario.failAt - 1) throw new Error(`${stepName(index)} refused`)

        return { seen: stepName(index) }
      },
      spec.undoable
        ? {
            undo: async (_seen, undoCtx) => {
              undoCtx.invocations.push(`compensate:${stepName(index)}`)
              if (spec.refusesUndo) throw new Error(`${stepName(index)} could not be undone`)
            },
          }
        : {},
    )

  const workflow = defineWorkflow(
    { name: 'property.compensation', input: markInput, execution: 'inline' },
    async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      if (scenario.concurrent) {
        await Promise.all(scenario.steps.map((spec, index) => call(wf, spec, index)))

        return
      }

      for (const [index, spec] of scenario.steps.entries()) await call(wf, spec, index)
    },
  )

  const thrown = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx }).then(
    () => null,
    (error: unknown) => error,
  )
  if (!(thrown instanceof SagaError)) {
    throw new Error(`the run should have failed at ${stepName(scenario.failAt - 1)}`)
  }

  const named = (prefix: string): string[] =>
    harness.invocations
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))

  return {
    invoked: named('invoke:'),
    undone: named('compensate:'),
    outcome: thrown.outcome,
    recorded: harness.runs[0]?.status ?? 'no run was opened',
  }
}

const scenario = fc
  .array(fc.record({ undoable: fc.boolean(), refusesUndo: fc.boolean() }), {
    minLength: 1,
    maxLength: 8,
  })
  .chain((steps) =>
    fc.record({
      steps: fc.constant(steps),
      failAt: fc.integer({ min: 1, max: steps.length }),
      concurrent: fc.boolean(),
    }),
  )

/*
 * Every one of these is a mistake somebody has shipped. If the specification could not tell
 * them apart from the right answer it would pass for ever while proving nothing, so each is
 * put to it here and has to be refused.
 */
describe('the specification tells the right unwinding from the classic wrong ones', () => {
  const undoable: StepSpec = { undoable: true, refusesUndo: false }
  const refusing: StepSpec = { undoable: true, refusesUndo: true }
  const sequential: Scenario = {
    steps: [undoable, undoable, undoable, undoable],
    failAt: 4,
    concurrent: false,
  }
  const right = specified(sequential)

  it('rejects undoing in the order the steps ran', () => {
    expect({ ...right, undone: right.undone.toReversed() }).not.toEqual(right)
  })

  it('rejects undoing the step that failed', () => {
    expect({ ...right, undone: [stepName(3), ...right.undone] }).not.toEqual(right)
  })

  it('rejects undoing a step twice', () => {
    expect({ ...right, undone: [...right.undone, stepName(0)] }).not.toEqual(right)
  })

  it('rejects leaving a completed step standing', () => {
    expect({ ...right, undone: right.undone.slice(1) }).not.toEqual(right)
  })

  it('rejects a run record that disagrees with the outcome it threw', () => {
    expect({ ...right, recorded: 'completed' }).not.toEqual(right)
  })

  it('calls a run failed when any undo refused, however many came back', () => {
    expect(
      specified({ ...sequential, steps: [refusing, undoable, undoable, undoable] }).outcome,
    ).toBe('failed')
  })

  // The relay is what makes "start order" a claim at all: concurrently, the steps finish in the
  // opposite order to the one they are undone in.
  it('undoes concurrent steps in the reverse of the order they started, not finished', () => {
    const concurrent = specified({ ...sequential, concurrent: true, failAt: 1 })

    expect(concurrent.undone).toEqual([stepName(3), stepName(2), stepName(1)])
  })
})

describe('compensation completeness', () => {
  it('holds for every failure point, every pattern of undos and every refusal', async () => {
    const coverage = createCoverage()

    await assertProperty(
      'every completed step is undone exactly once, in reverse start order',
      fc.asyncProperty(scenario, async (generated) => {
        const expected = specified(generated)
        coverage.saw(`${generated.concurrent ? 'concurrent' : 'sequential'}/${expected.outcome}`)
        coverage.saw(expected.undone.length > 1 ? 'several undos' : 'at most one undo')

        expect(await observed(generated)).toEqual(expected)
      }),
    )

    coverage.reached(
      'sequential/compensated',
      'sequential/failed',
      'concurrent/compensated',
      'concurrent/failed',
      'several undos',
      'at most one undo',
    )
  })
})
