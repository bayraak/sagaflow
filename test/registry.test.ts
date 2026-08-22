import { describe, expect, it } from 'bun:test'

import {
  createDurableRegistry,
  defineWorkflow,
  registerDurableWorkflow,
  type DurableWorkflowHandle,
} from '../src/index'
import { createLauncher } from './helpers/launcher'
import { passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const registered = (name: string) =>
  registerDurableWorkflow(
    defineWorkflow(
      { name, input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('only'), input)

        return { finished: `${name}:${input.mark}` }
      },
    ),
  )

describe('the durable registry', () => {
  it('finds a definition by the name it was registered under', () => {
    const registry = createDurableRegistry([registered('one'), registered('two')])

    expect(registry.find('two')?.name).toBe('two')
  })

  it('answers nothing for a name it does not know', () => {
    const registry = createDurableRegistry([registered('one')])

    expect(registry.find('missing')).toBeUndefined()
  })

  it('lists what it can dispatch', () => {
    const registry = createDurableRegistry([registered('one'), registered('two')])

    expect(registry.names()).toEqual(['one', 'two'])
  })

  // A dispatcher looks a workflow up by a name that arrived as a string, so it cannot know
  // which definition it found. Executing through the registration is how the definition keeps
  // its own types on the inside.
  it('executes the definition it found', async () => {
    const harness = createTestRuntime()
    const registry = createDurableRegistry([registered('one')])

    const output = await registry
      .find('one')
      ?.execute({ runId: 'run_given', input: { mark: 'x' } }, harness.ctx, passThroughPrimitive())

    expect(output).toEqual({ finished: 'one:x' })
    expect(harness.invocations).toEqual(['invoke:only'])
  })

  it('starts the definition it found', async () => {
    const harness = createTestRuntime()
    const { env, created } = createLauncher()
    const registry = createDurableRegistry([registered('one')])

    const started = await registry
      .find('one')
      ?.start(env, { input: { mark: 'x' }, ctx: harness.ctx })

    expect(started?.deduplicated).toBe(false)
    expect(created[0]?.params?.name).toBe('one')
  })
})
