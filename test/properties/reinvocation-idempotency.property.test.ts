import { describe, expect, it } from 'bun:test'

import * as fc from 'fast-check'

import { defineWorkflow } from '../../src/define.js'
import {
  envelopeId,
  executeDurable,
  reservedStepNames,
  type DurableWorkflowHandle,
  type StepCall,
  type StepContext,
  type StepPrimitive,
} from '../../src/index.js'
import { createCachingPrimitive } from '../helpers/primitive'
import { createTestRuntime, type TestRuntime } from '../helpers/runtime'
import { markInput } from '../helpers/steps'
import { assertProperty, createCoverage } from './harness'

/*
 * Guarantee 3. A durable body is invoked again whenever the platform feels like it — after a
 * deploy, after an isolate dies, after a retry — and the second invocation runs the body from
 * the top. Not one thing it already did may happen twice: every step executes once, and the
 * outbox ends holding exactly one set of rows.
 *
 * Two different re-invocations are generated here, because they break differently:
 *
 *   A crash. The platform recorded a step and the isolate died before the engine saw the
 *   answer. Modelled as a `do` call that never comes back, so nothing after it in that
 *   invocation happens at all — which is what dying is, and is why it cannot be modelled by
 *   throwing: a thrown error would run the engine's own unwinding, and a dead isolate runs
 *   nothing.
 *
 *   A step the platform never checkpointed. The work was done, the record was not written, and
 *   the next invocation does it again. Pointed at the engine's own finish and drain, this is
 *   what makes "identical ids" a real claim: the finish genuinely runs a second time, and the
 *   only thing standing between that and a duplicate set of rows is that the ids are a function
 *   of the run rather than of the clock.
 */

type Trace = {
  bodiesRun: string[]
  stepsExecuted: string[]
  outboxIds: string[]
  expectedIds: string[]
  runStatus: string
}

/**
 * The guarantee, as a check that refuses a trace it should never be shown.
 */
const assertOnce = (trace: Trace): void => {
  const ranTwice = duplicates(trace.bodiesRun)
  if (ranTwice.length > 0) throw new Error(`step bodies ran again: ${ranTwice.join(', ')}`)

  const executedTwice = duplicates(trace.stepsExecuted)
  if (executedTwice.length > 0) {
    throw new Error(`the platform executed steps again: ${executedTwice.join(', ')}`)
  }

  const queuedTwice = duplicates(trace.outboxIds)
  if (queuedTwice.length > 0) throw new Error(`events queued twice: ${queuedTwice.join(', ')}`)

  // A second set of rows under fresh ids is what a run whose envelope ids came from a clock
  // rather than from the run would produce, and is invisible to a duplicate check.
  const invented = trace.outboxIds.filter((id) => !trace.expectedIds.includes(id))
  if (invented.length > 0) {
    throw new Error(`events queued under ids this run cannot have minted: ${invented.join(', ')}`)
  }

  const lost = trace.expectedIds.filter((id) => !trace.outboxIds.includes(id))
  if (lost.length > 0) throw new Error(`the run never queued: ${lost.join(', ')}`)

  if (trace.runStatus !== 'completed') {
    throw new Error(`the run is ${trace.runStatus} after every invocation, not completed`)
  }
}

const duplicates = (values: string[]): string[] =>
  values.filter((value, index) => values.indexOf(value) !== index)

const cleanTrace: Trace = {
  bodiesRun: ['s0', 's1'],
  stepsExecuted: ['s0', 's1'],
  outboxIds: ['run_1:0', 'run_1:1'],
  expectedIds: ['run_1:0', 'run_1:1'],
  runStatus: 'completed',
}

describe('the check refuses every way a re-invocation can do something twice', () => {
  it('accepts a run whose steps each happened once and whose events are one set', () => {
    expect(() => assertOnce(cleanTrace)).not.toThrow()
  })

  it('refuses a step body that ran twice', () => {
    expect(() => assertOnce({ ...cleanTrace, bodiesRun: ['s0', 's1', 's0'] })).toThrow()
  })

  it('refuses a step the platform executed twice', () => {
    expect(() => assertOnce({ ...cleanTrace, stepsExecuted: ['s0', 's1', 's1'] })).toThrow()
  })

  it('refuses an event queued twice under the same id', () => {
    expect(() =>
      assertOnce({ ...cleanTrace, outboxIds: ['run_1:0', 'run_1:1', 'run_1:1'] }),
    ).toThrow()
  })

  it('refuses a second set of events queued under fresh ids', () => {
    expect(() =>
      assertOnce({ ...cleanTrace, outboxIds: ['run_1:0', 'run_1:1', 'run_1:2', 'run_1:3'] }),
    ).toThrow()
  })

  it('refuses a run that queued fewer events than it emitted', () => {
    expect(() => assertOnce({ ...cleanTrace, outboxIds: ['run_1:0'] })).toThrow()
  })

  it('refuses a run left open after all those invocations', () => {
    expect(() => assertOnce({ ...cleanTrace, runStatus: 'running' })).toThrow()
  })
})

/** A `do` call that never comes back, which is what an isolate dying looks like from inside. */
const dead = <Output>(): Promise<Output> => new Promise<Output>(() => undefined)

/**
 * One invocation of a durable body, on a platform that dies after a given number of steps have
 * been checkpointed. The cache underneath it survives, exactly as a real journal does.
 */
const mortalInvocation = (base: StepPrimitive, diesAfter: null | number) => {
  let checkpointed = 0
  let dying = false
  let announce!: (ending: 'died') => void
  const died = new Promise<'died'>((resolve) => (announce = resolve))

  const primitive: StepPrimitive = {
    do: async (name, config, run) => {
      if (dying) return dead()

      const output = await base.do(name, config, run)
      checkpointed += 1
      if (diesAfter !== null && checkpointed >= diesAfter) {
        dying = true
        announce('died')

        return dead()
      }

      return output
    },
    sleep: async (name, duration) => (dying ? dead() : base.sleep(name, duration)),
    waitForEvent: async (name, options) => (dying ? dead() : base.waitForEvent(name, options)),
  }

  return { primitive, died }
}

type Scenario = {
  steps: { emits: boolean }[]
  bodyEmits: boolean
  diesAfter: number[]
  neverCheckpointed: string[]
  extraInvocations: number
}

const stepName = (index: number): string => `s${index}`

const observed = async (scenario: Scenario): Promise<{ trace: Trace; deaths: number }> => {
  const harness = createTestRuntime()
  const runId = await harness.ctx.journal.insertRun({
    tenantId: harness.ctx.tenantId,
    name: 'property.reinvocation',
    execution: 'durable',
    idempotencyKey: null,
    input: { mark: 'x' },
    parentRunId: null,
  })

  const platform = createCachingPrimitive({ neverCache: scenario.neverCheckpointed })

  const workflow = defineWorkflow(
    { name: 'property.reinvocation', input: markInput, execution: 'durable' },
    async (_input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
      if (scenario.bodyEmits) wf.emit('invoice.voided', { invoiceId: 'body' })

      for (const [index, step] of scenario.steps.entries()) {
        const call: StepCall<{ seen: string }> = wf.step(
          stepName(index),
          async (stepCtx: StepContext<TestRuntime>) => {
            stepCtx.invocations.push(`invoke:${stepName(index)}`)
            if (step.emits) {
              stepCtx.emit('invoice.issued', { invoiceId: stepName(index), total: index })
            }

            return { seen: stepName(index) }
          },
        )
        await call
      }
    },
  )

  // Every generated death, then one invocation that is allowed to finish, then however many
  // pointless ones the scenario asked for on top — a platform re-invoking a run that is
  // already done must also change nothing.
  const invocations = [
    ...scenario.diesAfter,
    ...Array.from({ length: scenario.extraInvocations + 1 }, () => null),
  ]

  let deaths = 0
  for (const diesAfter of invocations) {
    const mortal = mortalInvocation(platform.primitive(), diesAfter)

    // A scheduled death that lands past the end of the body never happens, so what is counted
    // is the invocation that actually stopped rather than the one that was asked to.
    const ended = await Promise.race([
      executeDurable(workflow, { runId, input: { mark: 'x' } }, harness.ctx, mortal.primitive).then(
        () => 'returned' as const,
      ),
      mortal.died,
    ])
    if (ended === 'died') deaths += 1
  }

  const emitted = (scenario.bodyEmits ? 1 : 0) + scenario.steps.filter((step) => step.emits).length

  return {
    deaths,
    trace: {
      bodiesRun: harness.invocations.map((entry) => entry.slice('invoke:'.length)),
      stepsExecuted: platform.executed.filter(
        (name) => !(Object.values(reservedStepNames) as string[]).includes(name),
      ),
      outboxIds: harness.outbox.map((envelope) => envelope.id),
      expectedIds: Array.from({ length: emitted + 1 }, (_unused, ordinal) =>
        envelopeId(runId, ordinal),
      ),
      runStatus: harness.runs[0]?.status ?? 'no run was opened',
    },
  }
}

const scenario: fc.Arbitrary<Scenario> = fc.record({
  steps: fc.array(fc.record({ emits: fc.boolean() }), { minLength: 1, maxLength: 5 }),
  bodyEmits: fc.boolean(),
  diesAfter: fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 3 }),
  neverCheckpointed: fc.subarray(Object.values(reservedStepNames) as string[]),
  extraInvocations: fc.integer({ min: 0, max: 3 }),
})

describe('re-invocation idempotency', () => {
  it('holds however often the platform starts the body again', async () => {
    const coverage = createCoverage()

    await assertProperty(
      'a body invoked any number of times executes every step once and queues one set of events',
      fc.asyncProperty(scenario, async (generated) => {
        const { trace, deaths } = await observed(generated)
        coverage.saw(deaths > 0 ? 'an isolate actually died' : 'no isolate died')
        coverage.saw(
          generated.neverCheckpointed.includes(reservedStepNames.finishRun)
            ? 'the finish was never checkpointed'
            : 'the finish was checkpointed',
        )
        coverage.saw(
          generated.extraInvocations > 0 ? 'invoked again after finishing' : 'never invoked again',
        )

        assertOnce(trace)
      }),
    )

    coverage.reached(
      'an isolate actually died',
      'no isolate died',
      'the finish was never checkpointed',
      'the finish was checkpointed',
      'invoked again after finishing',
      'never invoked again',
    )
  })
})
