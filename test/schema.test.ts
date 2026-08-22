import { describe, expect, it } from 'bun:test'

import * as v from 'valibot'
import { z } from 'zod'

import {
  defineWorkflow,
  SchemaError,
  WorkflowError,
  type StandardSchemaV1,
  type WorkflowHandle,
  type WorkflowRuntime,
} from '../src/index'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markStep } from './helpers/steps'

const runWith = async (
  input: unknown,
  schema: StandardSchemaV1,
  ctx: ReturnType<typeof createTestRuntime>['ctx'],
) => {
  const workflow = defineWorkflow(
    { name: 'test.schema', input: schema, execution: 'inline' },
    async (parsed: unknown, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(markStep('only'), { mark: 'x' })

      return parsed
    },
  )

  return workflow.run({ input, ctx })
}

// Standard Schema is the whole reason this package has no dependencies: a caller brings the
// validator they already have, and the engine never learns which one it was.
describe('any Standard Schema validator will do', () => {
  it('accepts a Zod schema', async () => {
    const { ctx } = createTestRuntime()

    const result = await runWith({ mark: 'x' }, z.object({ mark: z.string() }), ctx)

    expect(!result.deduplicated && result.output).toEqual({ mark: 'x' })
  })

  it('accepts a Valibot schema', async () => {
    const { ctx } = createTestRuntime()

    const result = await runWith({ mark: 'x' }, v.object({ mark: v.string() }), ctx)

    expect(!result.deduplicated && result.output).toEqual({ mark: 'x' })
  })

  it('refuses what a Valibot schema refuses', async () => {
    const { ctx, runs } = createTestRuntime()

    const thrown = await runWith({ mark: 7 }, v.object({ mark: v.string() }), ctx).catch(
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(SchemaError)
    expect(runs).toEqual([])
  })

  // Input is parsed where the engine has an await to spend, so a validator that has to go and
  // look something up works exactly as a synchronous one does.
  it('waits for a validator that is asynchronous', async () => {
    const { ctx } = createTestRuntime()
    const looksItUp: StandardSchemaV1<{ mark: string }, { mark: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => {
          await Promise.resolve()
          const mark = (value as { mark?: unknown }).mark

          return typeof mark === 'string'
            ? { value: { mark } }
            : { issues: [{ message: 'mark must be a string' }] }
        },
      },
    }

    const accepted = await runWith({ mark: 'x' }, looksItUp, ctx)
    const refused = await runWith({ mark: 7 }, looksItUp, ctx).catch((error: unknown) => error)

    expect(!accepted.deduplicated && accepted.output).toEqual({ mark: 'x' })
    expect(refused).toBeInstanceOf(SchemaError)
  })
})

describe('what a refusal tells you', () => {
  it('names the thing that was refused and where in it', async () => {
    const { ctx } = createTestRuntime()

    const thrown = await runWith(
      { nested: { mark: 7 } },
      z.object({ nested: z.object({ mark: z.string() }) }),
      ctx,
    ).catch((error: unknown) => error)

    expect((thrown as SchemaError).message).toContain('the input of test.schema is invalid')
    expect((thrown as SchemaError).message).toContain('nested.mark')
    expect((thrown as SchemaError).issues).toHaveLength(1)
  })
})

// Declaring a map of event schemas is a promise that every event has a shape. A type missing
// from it is a mistake — a typo in an event name is otherwise invisible until a consumer
// silently stops receiving something.
const emitting = (type: string) =>
  defineWorkflow(
    { name: 'test.emit-check', input: z.object({}), execution: 'inline' },
    async (_input: unknown, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(markStep('only'), { mark: 'x' })
      ;(wf.emit as (type: string, payload: unknown) => void)(type, { invoiceId: 'INV-1' })
    },
  )

describe('emitting against a declared map', () => {
  it('refuses an event nothing declared', async () => {
    const { ctx, runs } = createTestRuntime()

    const thrown = await emitting('invoice.exploded')
      .run({ input: {}, ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect((thrown as WorkflowError).cause).toMatchObject({
      message: 'no event schema is declared for "invoice.exploded"',
    })
    expect(runs[0]?.status).toBe('compensated')
  })

  it('allows the facts the engine states about the run itself', async () => {
    const { ctx, outbox } = createTestRuntime()

    await emitting('workflow.completed').run({ input: {}, ctx })

    expect(outbox.map((event) => event.type)).toEqual(['workflow.completed', 'workflow.completed'])
  })

  it('lets a runtime that declares no map emit anything', async () => {
    const { ctx, outbox } = createTestRuntime()

    await emitting('invoice.exploded').run({ input: {}, ctx: { ...ctx, eventSchemas: undefined } })

    expect(outbox.map((event) => event.type)).toEqual(['invoice.exploded', 'workflow.completed'])
  })

  // `emit` returns void, so there is no await to spend on a validator that needs one. Saying so
  // is better than letting an unchecked payload through.
  it('refuses an event schema that validates asynchronously', async () => {
    const { ctx } = createTestRuntime()
    const slow: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => ({ value }),
      },
    }

    const workflow = defineWorkflow(
      { name: 'test.emit-slow', input: z.object({}), execution: 'inline' },
      async (_input: unknown, wf: WorkflowHandle<WorkflowRuntime>) => {
        wf.emit('invoice.slow', { invoiceId: 'INV-1' })
      },
    )

    const thrown = await workflow
      .run({
        input: {},
        ctx: {
          tenantId: ctx.tenantId,
          journal: ctx.journal,
          eventSchemas: { 'invoice.slow': slow },
        },
      })
      .catch((error: unknown) => error)

    expect((thrown as WorkflowError).cause).toBeInstanceOf(SchemaError)
    expect(((thrown as WorkflowError).cause as SchemaError).message).toContain(
      'validates asynchronously',
    )
  })
})
