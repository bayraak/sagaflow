import { describe, expect, it } from 'bun:test'

import { WorkflowError, type WorkflowRuntime } from '../src/index'
import { emittingWorkflow } from './helpers/emitting'
import type { TestEventSchemas } from './helpers/events'
import { createTestRuntime, firstRun } from './helpers/runtime'

describe('events are held until the run succeeds', () => {
  it('flushes what the body emitted', async () => {
    const { ctx, sent } = createTestRuntime()

    await emittingWorkflow().run({ input: { mark: 'INV-1' }, ctx })

    expect(sent.map((message) => message.type)).toContain('invoice.voided')
    expect(sent.find((message) => message.type === 'invoice.voided')?.payload).toEqual({
      invoiceId: 'INV-1',
    })
  })

  it('flushes what a step emitted', async () => {
    const { ctx, sent } = createTestRuntime()

    await emittingWorkflow().run({ input: { mark: 'INV-1' }, ctx })

    expect(sent.map((message) => message.type)).toContain('invoice.issued')
  })

  it('flushes nothing at all when the run compensates', async () => {
    const { ctx, sent } = createTestRuntime()

    await emittingWorkflow({ fails: true })
      .run({ input: { mark: 'INV-1' }, ctx })
      .catch(() => undefined)

    expect(sent).toEqual([])
  })

  it('flushes only after the run is closed', async () => {
    const { ctx, sent, runs } = createTestRuntime()
    const seen: string[] = []
    const finishRun = ctx.journal.finishRun

    const watched: WorkflowRuntime<TestEventSchemas> = {
      ...ctx,
      journal: {
        ...ctx.journal,
        finishRun: async (params) => {
          seen.push(`finish:${params.status}`)

          return finishRun(params)
        },
      },
      events: {
        sendBatch: async (messages) => {
          for (const message of messages) {
            seen.push(`send:${message.body.type}`)
            sent.push(message.body)
          }
        },
      },
    }

    await emittingWorkflow().run({ input: { mark: 'INV-1' }, ctx: { ...watched, invocations: [] } })

    expect(seen[0]).toBe('finish:completed')
    expect(seen.slice(1).every((entry) => entry.startsWith('send:'))).toBe(true)
    expect(firstRun(runs).status).toBe('completed')
  })

  it('announces the completed run itself', async () => {
    const { ctx, sent } = createTestRuntime()

    const result = await emittingWorkflow().run({ input: { mark: 'INV-1' }, ctx })
    const announcement = sent.find((message) => message.type === 'workflow.completed')

    expect(announcement?.payload).toEqual({ runId: result.runId, name: 'test.emitting' })
  })

  it('wraps each event in the tenant and run it came from', async () => {
    const { ctx, sent } = createTestRuntime()

    const result = await emittingWorkflow().run({ input: { mark: 'INV-1' }, ctx })

    expect(
      sent.every(
        (message) =>
          message.tenantId === 'tenant_local' &&
          message.runId === result.runId &&
          message.actor === 'tester' &&
          typeof message.occurredAt === 'number',
      ),
    ).toBe(true)
  })

  it('refuses a payload the schema does not accept', async () => {
    const { ctx, sent, runs } = createTestRuntime()

    const thrown = await emittingWorkflow({ badPayload: true })
      .run({ input: { mark: 'INV-1' }, ctx })
      .catch((error: unknown) => error)

    expect(thrown).toBeInstanceOf(WorkflowError)
    expect(sent).toEqual([])
    expect(firstRun(runs).status).toBe('compensated')
  })
})
