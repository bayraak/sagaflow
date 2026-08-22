import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import type { DurableWorkflowHandle } from '../src/index.js'
import { createDurableRegistry } from '../src/registry.js'
import { createLauncher } from './helpers/launcher'
import { passThroughPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const definitionFor = (name: string) =>
  defineWorkflow(
    { name, input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
      await wf.step(markStep('only'), input)

      return { finished: `${name}:${input.mark}` }
    },
  )

// Definitions go in as they are: registering each one is the library's ceremony, not the
// caller's, and a list of heterogeneous definitions holds together without a single cast.
describe('the durable registry', () => {
  it('finds a definition by the name it was registered under', () => {
    const registry = createDurableRegistry([definitionFor('one'), definitionFor('two')])

    expect(registry.find('two')?.name).toBe('two')
  })

  it('answers nothing for a name it does not know', () => {
    const registry = createDurableRegistry([definitionFor('one')])

    expect(registry.find('missing')).toBeUndefined()
  })

  it('lists what it can dispatch', () => {
    const registry = createDurableRegistry([definitionFor('one'), definitionFor('two')])

    expect(registry.names()).toEqual(['one', 'two'])
  })

  // A dispatcher looks a workflow up by a name that arrived as a string, so it cannot know
  // which definition it found. Executing through the registration is how the definition keeps
  // its own types on the inside.
  it('executes the definition it found', async () => {
    const harness = createTestRuntime()
    const registry = createDurableRegistry([definitionFor('one')])

    const output = await registry
      .find('one')
      ?.execute({ runId: 'run_given', input: { mark: 'x' } }, harness.ctx, passThroughPrimitive())

    expect(output).toEqual({ finished: 'one:x' })
    expect(harness.invocations).toEqual(['invoke:only'])
  })

  it('starts the definition it found', async () => {
    const harness = createTestRuntime()
    const { launcher, created } = createLauncher()
    const registry = createDurableRegistry([definitionFor('one')])

    const started = await registry
      .find('one')
      ?.start({ launcher, input: { mark: 'x' }, ctx: harness.ctx })

    expect(started?.deduplicated).toBe(false)
    expect(created[0]?.params?.name).toBe('one')
  })
})
