import { describe, expect, it } from 'bun:test'

import { defineWorkflow, type RunObserver, type WorkflowHandle } from '../src/index'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const recording = (): { observer: RunObserver; seen: string[] } => {
  const seen: string[] = []

  return {
    seen,
    observer: {
      onRunStart: (fact) => seen.push(`run-start:${fact.name}`),
      onStepStart: (fact) => seen.push(`step-start:${fact.name}:${fact.attempt}`),
      onStepEnd: (fact) => seen.push(`step-end:${fact.name}:${fact.status}`),
      onCompensationStart: (fact) => seen.push(`undo-start:${fact.name}`),
      onCompensationEnd: (fact) => seen.push(`undo-end:${fact.name}:${fact.status}`),
      onRunEnd: (fact) => seen.push(`run-end:${fact.status}`),
    },
  }
}

// The hook OpenTelemetry, a metrics counter or a log line hangs off. Plain facts, no objects
// from inside the engine, so an adapter cannot come to depend on the engine's shape.
describe('watching a run go by', () => {
  it('reports a run that completed', async () => {
    const harness = createTestRuntime()
    const watcher = recording()

    const workflow = defineWorkflow(
      { name: 'test.watched', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('first'), input)
        await wf.step(markStep('second'), input)
      },
    )

    await workflow.run({
      input: { mark: 'x' },
      ctx: { ...harness.ctx, observer: watcher.observer },
    })

    expect(watcher.seen).toEqual([
      'run-start:test.watched',
      'step-start:first:1',
      'step-end:first:completed',
      'step-start:second:1',
      'step-end:second:completed',
      'run-end:completed',
    ])
  })

  it('reports the unwinding of a run that did not', async () => {
    const harness = createTestRuntime()
    const watcher = recording()

    const workflow = defineWorkflow(
      { name: 'test.watched-failure', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('first'), input)
        await wf.step(markStep('boom', { fails: true }), input)
      },
    )

    await workflow
      .run({ input: { mark: 'x' }, ctx: { ...harness.ctx, observer: watcher.observer } })
      .catch(() => undefined)

    expect(watcher.seen).toEqual([
      'run-start:test.watched-failure',
      'step-start:first:1',
      'step-end:first:completed',
      'step-start:boom:1',
      'step-end:boom:failed',
      'undo-start:first',
      'undo-end:first:compensated',
      'run-end:compensated',
    ])
  })

  it('times what it reports', async () => {
    const harness = createTestRuntime()
    const durations: number[] = []

    const workflow = defineWorkflow(
      { name: 'test.watched-timing', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(markStep('only'), input),
    )

    await workflow.run({
      input: { mark: 'x' },
      ctx: {
        ...harness.ctx,
        observer: {
          onStepEnd: (fact) => durations.push(fact.durationMs),
          onRunEnd: (fact) => durations.push(fact.durationMs),
        },
      },
    })

    expect(durations).toHaveLength(2)
    expect(durations.every((duration) => duration >= 0)).toBe(true)
  })

  // An observability hook must never be able to fail a mutation. A metrics backend having a bad
  // day is not a reason to refuse somebody's invoice.
  it('cannot break the run it is watching', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.watched-hostile', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(markStep('only'), input),
    )

    const hostile: RunObserver = {
      onRunStart: () => {
        throw new Error('the metrics backend is down')
      },
      onStepEnd: () => {
        throw new Error('still down')
      },
      onRunEnd: () => {
        throw new Error('down')
      },
    }

    const result = await workflow.run({
      input: { mark: 'x' },
      ctx: { ...harness.ctx, observer: hostile },
    })

    expect(!result.deduplicated && result.output).toEqual({ seen: 'only:x' })
    expect(harness.runs[0]?.status).toBe('completed')
  })

  it('costs nothing when nobody is watching', async () => {
    const harness = createTestRuntime()

    const workflow = defineWorkflow(
      { name: 'test.unwatched', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) =>
        wf.step(markStep('only'), input),
    )

    const result = await workflow.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(!result.deduplicated && result.output).toEqual({ seen: 'only:x' })
  })
})
