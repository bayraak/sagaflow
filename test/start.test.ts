import { describe, expect, it } from 'bun:test'

import { defineWorkflow } from '../src/define.js'
import { instanceIdFor, startDurableWorkflow, type DurableWorkflowHandle } from '../src/index.js'
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
    const { launcher, created } = createLauncher()

    const { runId } = await startDurableWorkflow({
      launcher,
      definition: startable(),
      input: { mark: 'x' },
      ctx,
    })

    expect(firstRun(runs).id).toBe(runId)
    expect(firstRun(runs).execution).toBe('durable')
    expect(firstRun(runs).status).toBe('running')
    expect(created).toHaveLength(1)
  })

  it('hands the instance the tenant, the actor, the input and the run', async () => {
    const { ctx } = createTestRuntime()
    const { launcher, created } = createLauncher()

    const { runId } = await startDurableWorkflow({
      launcher,
      definition: startable(),
      input: { mark: 'x' },
      ctx,
    })

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
    const { launcher, created } = createLauncher()

    await startDurableWorkflow({
      launcher,
      definition: startable(),
      input: { mark: '' },
      ctx,
    }).catch(() => undefined)

    expect(runs).toEqual([])
    expect(created).toEqual([])
  })

  it('answers a held key with the run that holds it, and starts nothing', async () => {
    const { ctx, runs } = createTestRuntime()
    const { launcher, created } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
    })
    const second = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
    })

    expect(second).toEqual({ runId: first.runId, deduplicated: true })
    expect(runs).toHaveLength(1)
    expect(created).toHaveLength(1)
  })

  // A replay is identified by the RUN it replays, never by the input it carries: a replay that
  // kept the definition's own key would arrive at the very key the original run claimed and be
  // told "already done" — the one answer a replay must never give.
  it('keys a replay on the run it is replaying', async () => {
    const { ctx, runs } = createTestRuntime()
    const { launcher } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
    })
    const replay = await startDurableWorkflow({
      launcher,
      definition: definition,
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
    const { launcher } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
    })
    const once = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
      replayOf: first.runId,
    })
    const twice = await startDurableWorkflow({
      launcher,
      definition: definition,
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
    const { launcher } = createLauncher({ refusesWith: new Error('the platform is unavailable') })

    const thrown = await startDurableWorkflow({
      launcher,
      definition: startable(),
      input: { mark: 'x' },
      ctx,
    }).catch((error: unknown) => error)

    expect((thrown as Error).message).toContain('the platform is unavailable')
    expect(firstRun(runs).status).toBe('failed')
    expect(firstRun(runs).error).toContain('the platform is unavailable')
  })
})

// The instance id used to be a digest of the tenant and the idempotency key, which made the
// platform a second dedup authority beside the run record — and the two disagreed the moment a
// run record was swept away: the key was free, the instance id was not, and the work could
// never be asked for again. The run record is the only authority now, and the instance id is
// simply the name of the run it belongs to.
describe('the id a durable instance is created under', () => {
  it('is derived from the run', async () => {
    const { ctx } = createTestRuntime()
    const { launcher, created } = createLauncher()

    const { runId } = await startDurableWorkflow({
      launcher,
      definition: startable(),
      input: { mark: 'x' },
      ctx,
    })

    expect(created[0]?.id).toBe(instanceIdFor('test.startable', runId))
    expect(created[0]?.id).toContain(runId)
  })

  it('carries the workflow name so it can be recognised in a dashboard', () => {
    expect(instanceIdFor('invoice.send', 'run_7')).toBe('wf-invoice-send-run_7')
  })

  // Cloudflare Workflows accepts `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` within 100 characters, and
  // workflow names carry dots that the keys themselves are not allowed to.
  it('is legal wherever it is used, however long the name is', () => {
    const id = instanceIdFor(`billing.${'very-long-segment.'.repeat(12)}send`, 'run_7')

    expect(id).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/)
    expect(id.length).toBeLessThanOrEqual(100)
  })

  it('gives two runs of one key two ids once the first has released it', async () => {
    const { ctx, runs, journal } = createTestRuntime()
    const { launcher, created } = createLauncher()
    const definition = startable()

    const first = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
    })
    await journal.finishRun({
      tenantId: 'tenant_local',
      runId: first.runId,
      status: 'failed',
      error: 'the instance died',
    })

    const second = await startDurableWorkflow({
      launcher,
      definition: definition,
      input: { mark: 'x' },
      ctx,
    })

    expect(second.deduplicated).toBe(false)
    expect(runs).toHaveLength(2)
    expect(created.map((instance) => instance.id)).toEqual([
      instanceIdFor('test.startable', first.runId),
      instanceIdFor('test.startable', second.runId),
    ])
  })

  it('names an unkeyed run the same way a keyed one is named', async () => {
    const { ctx } = createTestRuntime()
    const { launcher, created } = createLauncher()

    const unkeyed = defineWorkflow(
      { name: 'test.unkeyed', input: markInput, execution: 'durable' },
      async (input: { mark: string }, wf: DurableWorkflowHandle<TestRuntime>) => {
        await wf.step(markStep('only'), input)
      },
    )

    const { runId } = await startDurableWorkflow({
      launcher,
      definition: unkeyed,
      input: { mark: 'x' },
      ctx,
    })

    expect(created[0]?.id).toBe(instanceIdFor('test.unkeyed', runId))
  })

  // With an id that is unique per run, a platform reporting a duplicate instance is reporting
  // something impossible rather than something routine — so it is raised rather than quietly
  // read as "already under way".
  it('raises a duplicate-instance refusal instead of reading it as success', async () => {
    const { ctx, runs } = createTestRuntime()
    const { launcher } = createLauncher({ refusesWith: new Error('instance already exists') })

    const thrown = await startDurableWorkflow({
      launcher,
      definition: startable(),
      input: { mark: 'x' },
      ctx,
    }).catch((error: unknown) => error)

    expect((thrown as Error).message).toContain('instance already exists')
    expect(firstRun(runs).status).toBe('failed')
  })
})
