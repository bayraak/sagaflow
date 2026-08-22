import { describe, expect, it } from 'bun:test'

import {
  sendWorkflowEvent,
  type WorkflowInstanceHandle,
  type WorkflowInstanceLookup,
} from '../src/cloudflare/send-event'
import { defineWorkflow, instanceIdFor, startDurableWorkflow } from '../src/index'
import type { DurableWorkflowHandle } from '../src/index'
import { createLauncher } from './helpers/launcher'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const waiting = defineWorkflow(
  { name: 'invoice.approve', input: markInput, execution: 'durable' },
  async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
    await wf.step(markStep('propose'), input)
    await wf.waitForEvent('approval', { type: 'approved' })
  },
)

const createLookup = (): { binding: WorkflowInstanceLookup; asked: string[]; sent: unknown[] } => {
  const asked: string[] = []
  const sent: unknown[] = []

  const handle: WorkflowInstanceHandle = {
    sendEvent: async (event) => {
      sent.push(event)
    },
  }

  return {
    asked,
    sent,
    binding: {
      get: async (id) => {
        asked.push(id)

        return handle
      },
    },
  }
}

// An approval endpoint that built the instance id by hand would be a second copy of a format
// that must never drift. The day it changed, every waiting run would become unreachable and
// nothing would fail loudly — so the caller names the run and the library does the rest.
describe('waking a run that is waiting', () => {
  it('asks for the instance the launcher actually created', async () => {
    const harness = createTestRuntime()
    const { launcher, created } = createLauncher()
    const lookup = createLookup()

    const { runId } = await startDurableWorkflow({
      launcher,
      definition: waiting,
      input: { mark: 'x' },
      ctx: harness.ctx,
    })

    await sendWorkflowEvent({
      binding: lookup.binding,
      name: waiting.name,
      runId,
      event: { type: 'approved', payload: { by: 'someone' } },
    })

    expect(lookup.asked).toEqual([created[0]?.id as string])
    expect(lookup.asked).toEqual([instanceIdFor('invoice.approve', runId)])
  })

  it('delivers the event as it was given', async () => {
    const lookup = createLookup()

    await sendWorkflowEvent({
      binding: lookup.binding,
      name: 'invoice.approve',
      runId: 'run_7',
      event: { type: 'approved', payload: { by: 'someone' } },
    })

    expect(lookup.sent).toEqual([{ type: 'approved', payload: { by: 'someone' } }])
  })
})
