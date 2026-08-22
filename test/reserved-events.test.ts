import { describe, expect, it } from 'bun:test'

import {
  defineWorkflow,
  lifecycleEventTypes,
  WorkflowError,
  type WorkflowHandle,
} from '../src/index'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

// The engine states exactly one fact about every run it closes. A body that emitted the same
// type would put a second one on the table, and a consumer counting runs — an audit log, a
// metrics mirror — would quietly count wrong. The name belongs to the engine, like the step
// names it uses for itself.
const emitting = (type: string) =>
  defineWorkflow(
    { name: 'test.emit-lifecycle', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(markStep('only'), input)
      ;(wf.emit as (type: string, payload: unknown) => void)(type, {
        runId: 'run_1',
        name: 'whatever',
      })
    },
  )

describe('the event types the engine keeps for itself', () => {
  it('refuses a body that emits one of them', async () => {
    for (const reserved of lifecycleEventTypes) {
      const harness = createTestRuntime()

      const thrown = await emitting(reserved)
        .run({ input: { mark: 'x' }, ctx: harness.ctx })
        .catch((error: unknown) => error)

      expect(thrown).toBeInstanceOf(WorkflowError)
      expect(((thrown as WorkflowError).cause as Error).message).toBe(
        `"${reserved}" is emitted by the engine and cannot be emitted by a workflow`,
      )
    }
  })

  it('refuses it even when no schema map is declared', async () => {
    const harness = createTestRuntime()

    const thrown = await emitting('workflow.completed')
      .run({ input: { mark: 'x' }, ctx: { ...harness.ctx, eventSchemas: undefined } })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
  })

  it('still emits exactly one of them itself', async () => {
    const harness = createTestRuntime()

    const honest = defineWorkflow(
      { name: 'test.honest', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('only'), input)
      },
    )

    await honest.run({ input: { mark: 'x' }, ctx: harness.ctx })

    expect(harness.outbox.map((event) => event.type)).toEqual(['workflow.completed'])
  })
})
