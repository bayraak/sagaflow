import { describe, expect, it } from 'bun:test'

import { executeDurable, saga, sagaflow, type WorkflowHandle } from 'sagaflow-js'

import { defineWorkflow } from '../src/define.js'
import { defineStep } from '../src/step.js'
import { createCachingPrimitive } from './helpers/primitive'
import { createTestRuntime, type TestRuntime } from './helpers/runtime'
import { markInput } from './helpers/steps'

/*
 * Plenty of work is not asynchronous. Totalling a basket, deriving a reference, checking an
 * invariant — a step exists to record that it happened and to hang an undo on it, not because it
 * waits for anybody. Making those authors write `async () => value` or `Promise.resolve(value)`
 * is a tax on the common case, paid to a signature rather than to the runtime: the engine has
 * always awaited whatever a step hands back, and awaiting a plain value is what `await` is for.
 */
describe('a step whose work is not asynchronous', () => {
  it('records what it returned, like any other step', async () => {
    const harness = createTestRuntime()

    const total = saga('basket.total', async (input: { mark: string }, s) => {
      const counted = await s.step('count', () => ({ items: 2, of: input.mark }))

      return counted
    })

    const result = await total(
      { mark: 'a' },
      sagaflow({ journal: harness.ctx.journal, warn: () => undefined }),
    )

    expect(result).toEqual({ items: 2, of: 'a' })
    expect(harness.steps.map((entry) => [entry.name, entry.status, entry.output])).toEqual([
      ['count', 'completed', { items: 2, of: 'a' }],
    ])
  })

  it('is memoised by a durable platform exactly like an asynchronous one', async () => {
    const harness = createTestRuntime()
    let ran = 0

    const workflow = defineWorkflow(
      { name: 'sync.memoised', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        const counted = await wf.step('count', () => {
          ran += 1

          return { items: 2, of: input.mark }
        })

        return counted
      },
    )

    const runId = await harness.journal.insertRun({
      tenantId: 'tenant_local',
      name: 'sync.memoised',
      execution: 'durable',
      idempotencyKey: null,
      input: { mark: 'a' },
    })
    const platform = createCachingPrimitive({ crashOnce: ['finish-run'] })

    await executeDurable(
      workflow,
      { runId, input: { mark: 'a' } },
      harness.ctx,
      platform.primitive(),
    ).catch(() => undefined)
    const output = await executeDurable(
      workflow,
      { runId, input: { mark: 'a' } },
      harness.ctx,
      platform.primitive(),
    )

    expect(ran).toBe(1)
    expect(output).toEqual({ items: 2, of: 'a' })
  })

  it('undoes synchronously too, when there is nothing to wait for', async () => {
    const harness = createTestRuntime()
    const released: string[] = []

    const book = saga('seat.book', async (input: { mark: string }, s) => {
      await s.step(
        'reserve',
        () => ({ id: input.mark }),
        (reserved) => {
          released.push(reserved.id)
        },
      )
      await s.step('charge', () => {
        throw new Error('the card was declined')
      })
    })

    await book(
      { mark: '12A' },
      sagaflow({ journal: harness.ctx.journal, warn: () => undefined }),
    ).catch(() => undefined)

    expect(released).toEqual(['12A'])
  })

  it('is declarable as a reusable step, run and undo both', async () => {
    const harness = createTestRuntime()
    const released: number[] = []

    const reserve = defineStep<TestRuntime, { mark: string }, { id: number }>('reserve', {
      run: (input) => ({ id: input.mark.length }),
      undo: (reserved) => {
        released.push(reserved.id)
      },
    })

    const workflow = defineWorkflow(
      { name: 'sync.reusable', input: markInput, execution: 'inline' },
      async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
        await wf.step(reserve, input)
        await wf.step(
          defineStep<TestRuntime, { mark: string }, never>('fail', {
            run: () => {
              throw new Error('no')
            },
          }),
          input,
        )
      },
    )

    await workflow.run({ input: { mark: 'abc' }, ctx: harness.ctx }).catch(() => undefined)

    expect(released).toEqual([3])
  })
})
