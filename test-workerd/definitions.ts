import { z } from 'zod'

import {
  createStep,
  defineWorkflow,
  type DurableWorkflowHandle,
  type EventSink,
  type StepContext,
  type WorkflowHandle,
  type WorkflowRuntime,
} from '../src/index.js'

export type TestEnv = {
  DB: D1Database
  WORKFLOWS: Workflow
  EVENTS: Queue<unknown> & EventSink
}

export type TestRuntime = WorkflowRuntime & { db: D1Database }

const thingInput = z.object({ mark: z.string().min(1) })

// A step with a real database effect and a real undo, so the D1 journal is exercised by a
// workflow rather than by a suite poking at it directly.
const writeThing = createStep('write-thing', {
  run: async (input: { mark: string }, ctx: StepContext<TestRuntime>) => {
    await ctx.db
      .prepare('insert into things (id, tenant_id, mark) values (?, ?, ?)')
      .bind(ctx.idempotencyKey, ctx.tenantId, input.mark)
      .run()

    return { id: ctx.idempotencyKey }
  },
  compensate: async (written: { id: string }, ctx: StepContext<TestRuntime>) => {
    await ctx.db.prepare('delete from things where id = ?').bind(written.id).run()
  },
})

const refuse = createStep('refuse', {
  run: async (): Promise<never> => {
    throw new Error('this step always refuses')
  },
})

export const saveThing = defineWorkflow(
  { name: 'thing.save', input: thingInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
    const written = await wf.step(writeThing, input)
    wf.emit('thing.saved', { id: written.id, mark: input.mark })

    return { id: written.id }
  },
)

export const saveThingBadly = defineWorkflow(
  { name: 'thing.save-badly', input: thingInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
    await wf.step(writeThing, input)
    await wf.step(refuse, input)
  },
)

export const shipThing = defineWorkflow(
  {
    name: 'thing.ship',
    input: thingInput,
    execution: 'durable',
    idempotency: (input) => `thing.ship:${input.mark}`,
  },
  async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
    const written = await wf.step(writeThing, input)
    await wf.sleep('settle', '1 second')
    wf.emit('thing.shipped', { id: written.id })

    return { id: written.id }
  },
)
