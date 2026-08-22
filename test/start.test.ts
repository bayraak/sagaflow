import { describe, expect, it } from 'bun:test'

import { defineWorkflow, startDurableWorkflow, type DurableWorkflowHandle } from '../src/index'
import { createLauncher } from './helpers/launcher'
import { createTestRuntime, firstRun, type TestRuntime } from './helpers/runtime'
import { markInput, markStep } from './helpers/steps'

const startable = () =>
  defineWorkflow(
    {
      name: 'test.startable',
      input: markInput,
      execution: 'durable',
      idempotency: (input) => `test.startable:${input.mark}`,
    },
    async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
      await wf.step(markStep('only'), input)

      return { finished: input.mark }
    },
  )

describe('starting a durable workflow', () => {
  it('opens the run record before the instance exists', async () => {
    const { ctx, runs } = createTestRuntime()
    const { env, created } = createLauncher()

    const { runId } = await startDurableWorkflow(env, startable(), { input: { mark: 'x' }, ctx })

    expect(firstRun(runs).id).toBe(runId)
    expect(firstRun(runs).execution).toBe('durable')
    expect(firstRun(runs).status).toBe('running')
    expect(created).toHaveLength(1)
  })

  it('hands the instance the tenant, the actor, the input and the run', async () => {
    const { ctx } = createTestRuntime()
    const { env, created } = createLauncher()

    const { runId } = await startDurableWorkflow(env, startable(), { input: { mark: 'x' }, ctx })

    expect(created[0]?.params).toEqual({
      name: 'test.startable',
      tenantId: 'tenant_local',
      actor: 'tester',
      input: { mark: 'x' },
      runId,
    })
  })

  it('refuses an input the schema does not accept, leaving no run and no instance', async () => {
    const { ctx, runs } = createTestRuntime()
    const { env, created } = createLauncher()

    await startDurableWorkflow(env, startable(), { input: { mark: '' }, ctx }).catch(
      () => undefined,
    )

    expect(runs).toEqual([])
    expect(created).toEqual([])
  })

  it('answers a held key with the run that holds it, and starts nothing', async () => {
    const { ctx, runs } = createTestRuntime()
    const { env, created } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow(env, definition, { input: { mark: 'x' }, ctx })
    const second = await startDurableWorkflow(env, definition, { input: { mark: 'x' }, ctx })

    expect(second).toEqual({ runId: first.runId, deduplicated: true })
    expect(runs).toHaveLength(1)
    expect(created).toHaveLength(1)
  })

  // A replay is identified by the RUN it replays, never by the input it carries: a replay that
  // kept the definition's own key would arrive at the very key the original run claimed and be
  // told "already done" — the one answer a replay must never give.
  it('keys a replay on the run it is replaying', async () => {
    const { ctx, runs } = createTestRuntime()
    const { env } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow(env, definition, { input: { mark: 'x' }, ctx })
    const replay = await startDurableWorkflow(env, definition, {
      input: { mark: 'x' },
      ctx,
      replayOf: first.runId,
    })

    expect(replay.deduplicated).toBe(false)
    expect(runs).toHaveLength(2)
    expect(runs[1]?.idempotencyKey).toBe(`replay:${first.runId}`)
  })

  it('answers the same replay asked for twice with one replay', async () => {
    const { ctx, runs } = createTestRuntime()
    const { env } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow(env, definition, { input: { mark: 'x' }, ctx })
    const once = await startDurableWorkflow(env, definition, {
      input: { mark: 'x' },
      ctx,
      replayOf: first.runId,
    })
    const twice = await startDurableWorkflow(env, definition, {
      input: { mark: 'x' },
      ctx,
      replayOf: first.runId,
    })

    expect(twice).toEqual({ runId: once.runId, deduplicated: true })
    expect(runs).toHaveLength(2)
  })

  // The run record exists before the instance does precisely so that a launcher which refuses
  // leaves something behind to explain the refusal.
  it('closes the run as failed when the launcher refuses', async () => {
    const { ctx, runs } = createTestRuntime()
    const { env } = createLauncher({ refusesWith: new Error('the platform is unavailable') })

    const thrown = await startDurableWorkflow(env, startable(), {
      input: { mark: 'x' },
      ctx,
    }).catch((error: unknown) => error)

    expect((thrown as Error).message).toContain('the platform is unavailable')
    expect(firstRun(runs).status).toBe('failed')
    expect(firstRun(runs).error).toContain('the platform is unavailable')
  })
})
