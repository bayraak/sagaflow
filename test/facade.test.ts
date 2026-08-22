import { describe, expect, it } from 'bun:test'

import {
  createSagaflow,
  defineWorkflow,
  type StandardSchemaV1,
  type WorkflowHandle,
  type WorkflowRuntime,
} from '../src/index'
import { createMemoryJournal, createMemorySink } from '../src/memory/index'
import { createLauncher } from './helpers/launcher'
import { markInput } from './helpers/steps'

const saveThing = defineWorkflow(
  { name: 'thing.save', input: markInput, execution: 'inline' },
  async (input: { mark: string }, wf: WorkflowHandle<WorkflowRuntime>) =>
    wf.step('write', async () => ({ written: input.mark })),
)

const shipThing = defineWorkflow(
  { name: 'thing.ship', input: markInput, execution: 'durable' },
  async (input: { mark: string }, wf: WorkflowHandle<WorkflowRuntime>) =>
    wf.step('ship', async () => ({ shipped: input.mark })),
)

// The runtime object is the honest low-level form and it stays. But most callers assemble the
// same one on every request, and the assembly is not the interesting part of their code.
describe('the façade', () => {
  it('runs a workflow for a tenant', async () => {
    const memory = createMemoryJournal()
    const sink = createMemorySink()
    const saga = createSagaflow({ journal: memory.journal, events: sink.sink })

    const result = await saga.for({ tenantId: 'acme', actor: 'tester' }).run(saveThing, {
      mark: 'THING-1',
    })

    expect(!result.deduplicated && result.output).toEqual({ written: 'THING-1' })
    expect(memory.runs[0]).toMatchObject({ tenantId: 'acme', name: 'thing.save' })
    expect(sink.sent.every((event) => event.tenantId === 'acme' && event.actor === 'tester')).toBe(
      true,
    )
  })

  it('starts a durable workflow', async () => {
    const memory = createMemoryJournal()
    const { launcher, created } = createLauncher()
    const saga = createSagaflow({ journal: memory.journal })

    const started = await saga
      .for({ tenantId: 'acme' })
      .start(launcher, shipThing, { mark: 'THING-2' })

    expect(started.deduplicated).toBe(false)
    expect(created[0]?.params).toMatchObject({ name: 'thing.ship', tenantId: 'acme' })
  })

  it('passes the parent run through', async () => {
    const memory = createMemoryJournal()
    const saga = createSagaflow({ journal: memory.journal })
    const scope = saga.for({ tenantId: 'acme' })

    const parent = await scope.run(saveThing, { mark: 'P' })
    await scope.run(saveThing, { mark: 'C' }, { parentRunId: parent.runId })

    expect(memory.runs.map((run) => run.parentRunId)).toEqual([null, parent.runId])
  })

  it('cancels a run', async () => {
    const memory = createMemoryJournal()
    const saga = createSagaflow({ journal: memory.journal })
    const scope = saga.for({ tenantId: 'acme' })

    const runId = await memory.journal.insertRun({
      tenantId: 'acme',
      name: 'thing.ship',
      execution: 'durable',
      idempotencyKey: null,
      input: {},
    })

    expect(await scope.cancel(runId)).toBe(true)
    expect(await scope.cancel('run_nowhere')).toBe(false)
  })

  it('hands out the runtime object for anybody who wants it', async () => {
    const memory = createMemoryJournal()
    const saga = createSagaflow({ journal: memory.journal })

    const runtime = saga.runtime({ tenantId: 'acme', actor: 'tester' })

    expect(runtime.tenantId).toBe('acme')
    expect(runtime.actor).toBe('tester')
    expect(runtime.journal).toBe(memory.journal)
  })

  it('defaults the tenant for the single-tenant case', async () => {
    const memory = createMemoryJournal()
    const saga = createSagaflow({ journal: memory.journal })

    await saga.for({}).run(saveThing, { mark: 'THING-3' })

    expect(memory.runs[0]?.tenantId).toBe('default')
  })
})

// Zero arguments has to do something useful or nobody tries the library at all. It also has to
// be impossible to mistake for something you would deploy.
describe('the façade with nothing configured', () => {
  it('runs, in memory, and says loudly that nothing is durable', async () => {
    const warnings: string[] = []
    const saga = createSagaflow({ warn: (message) => warnings.push(message) })

    const result = await saga.for({}).run(saveThing, { mark: 'THING-4' })

    expect(!result.deduplicated && result.output).toEqual({ written: 'THING-4' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('not durable')
  })

  it('says it once, not once per run', async () => {
    const warnings: string[] = []
    const saga = createSagaflow({ warn: (message) => warnings.push(message) })

    await saga.for({}).run(saveThing, { mark: 'a' })
    await saga.for({}).run(saveThing, { mark: 'b' })

    expect(warnings).toHaveLength(1)
  })
})

// `idempotency: true` for the common case, where the key is "this exact input, once".
describe('a key derived from the input', () => {
  const once = defineWorkflow(
    { name: 'thing.once', input: markInput, execution: 'inline', idempotency: true },
    async (input: { mark: string }, wf: WorkflowHandle<WorkflowRuntime>) =>
      wf.step('write', async () => ({ written: input.mark })),
  )

  it('answers the same input twice with one run', async () => {
    const memory = createMemoryJournal()
    const saga = createSagaflow({ journal: memory.journal })
    const scope = saga.for({ tenantId: 'acme' })

    const first = await scope.run(once, { mark: 'SAME' })
    const second = await scope.run(once, { mark: 'SAME' })

    expect(second.deduplicated).toBe(true)
    expect(second.runId).toBe(first.runId)
    expect(memory.runs).toHaveLength(1)
  })

  it('lets a different input run', async () => {
    const memory = createMemoryJournal()
    const scope = createSagaflow({ journal: memory.journal }).for({ tenantId: 'acme' })

    await scope.run(once, { mark: 'A' })
    const second = await scope.run(once, { mark: 'B' })

    expect(second.deduplicated).toBe(false)
    expect(memory.runs).toHaveLength(2)
  })

  // Key order is not meaning. Two objects that say the same thing derive the same key.
  it('does not care what order the input was written in', async () => {
    const anyObject: StandardSchemaV1<Record<string, unknown>, Record<string, unknown>> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: value as Record<string, unknown> }),
      },
    }

    const wide = defineWorkflow(
      { name: 'thing.wide', input: anyObject, execution: 'inline', idempotency: true },
      async (_input: Record<string, unknown>, wf: WorkflowHandle<WorkflowRuntime>) =>
        wf.step('write', async () => 1),
    )

    const memory = createMemoryJournal()
    const scope = createSagaflow({ journal: memory.journal }).for({ tenantId: 'acme' })

    await scope.run(wide, { a: 1, b: { c: 2, d: 3 } })
    const second = await scope.run(wide, { b: { d: 3, c: 2 }, a: 1 })

    expect(second.deduplicated).toBe(true)
    expect(memory.runs).toHaveLength(1)
  })

  it('does not collide across workflows', async () => {
    const other = defineWorkflow(
      { name: 'thing.other', input: markInput, execution: 'inline', idempotency: true },
      async (_input: { mark: string }, wf: WorkflowHandle<WorkflowRuntime>) =>
        wf.step('write', async () => 2),
    )

    const memory = createMemoryJournal()
    const scope = createSagaflow({ journal: memory.journal }).for({ tenantId: 'acme' })

    await scope.run(once, { mark: 'SAME' })
    const second = await scope.run(other, { mark: 'SAME' })

    expect(second.deduplicated).toBe(false)
  })
})
