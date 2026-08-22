import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import {
  executeDurable,
  type DurableWorkflow,
  type DurableWorkflowHandle,
  type InlineWorkflow,
  type WorkflowHandle,
} from '../src/index.js'
import { createFakePrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

const capturedInlineHandle = async () => {
  const { ctx } = createTestRuntime()
  let captured: Record<string, unknown> = {}

  const capturing = defineWorkflow(
    { name: 'test.inline-handle', input: markInput, execution: 'inline' },
    async (_input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      captured = wf as unknown as Record<string, unknown>

      return { finished: 'nothing' }
    },
  )

  await capturing.run({ input: { mark: 'x' }, ctx })

  return captured
}

describe('only a durable handle can wait', () => {
  it('gives an inline body no way to sleep', async () => {
    expect('sleep' in (await capturedInlineHandle())).toBe(false)
  })

  it('gives an inline body no way to wait for an event', async () => {
    expect('waitForEvent' in (await capturedInlineHandle())).toBe(false)
  })

  it('gives a durable body both', async () => {
    const harness = createTestRuntime()
    const { primitive } = createFakePrimitive({ event: { ok: true } })
    let captured: Record<string, unknown> = {}

    const capturing = defineWorkflow(
      { name: 'test.durable-handle', input: markInput, execution: 'durable' },
      async (_input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        captured = wf as unknown as Record<string, unknown>

        return { finished: 'nothing' }
      },
    )

    await executeDurable(
      capturing,
      { runId: 'run_given', input: { mark: 'x' } },
      harness.ctx,
      primitive,
    )

    expect('sleep' in captured).toBe(true)
    expect('waitForEvent' in captured).toBe(true)
  })
})

// The executor split is a type, not a convention: an inline body that reaches for `sleep` or
// `waitForEvent` fails the compiler, because an inline handle has no such member to reach for.
type AssertTrue<T extends true> = T

export type AnInlineHandleCannotSleep = AssertTrue<
  'sleep' extends keyof WorkflowHandle<TestRuntime> ? false : true
>

export type AnInlineHandleCannotWaitForEvent = AssertTrue<
  'waitForEvent' extends keyof WorkflowHandle<TestRuntime> ? false : true
>

export type ADurableHandleCanSleep = AssertTrue<
  'sleep' extends keyof DurableWorkflowHandle<TestRuntime> ? true : false
>

export type ADurableHandleCanWaitForEvent = AssertTrue<
  'waitForEvent' extends keyof DurableWorkflowHandle<TestRuntime> ? true : false
>

export type AnInlineDefinitionCanRunItself = AssertTrue<
  'run' extends keyof InlineWorkflow<TestRuntime, typeof markInput, unknown> ? true : false
>

export type ADurableDefinitionCannotRunItself = AssertTrue<
  'run' extends keyof DurableWorkflow<TestRuntime, typeof markInput, unknown> ? false : true
>
