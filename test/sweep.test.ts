import { describe, expect, it } from 'bun:test'

import { sweepAbandonedRuns } from '../src/index.js'
import { createMemoryJournal } from '../src/memory/index'

const minute = 60_000

const openRun = async (
  journal: ReturnType<typeof createMemoryJournal>,
  params: { execution: 'durable' | 'inline'; name: string },
) =>
  journal.journal.insertRun({
    tenantId: 'tenant_local',
    name: params.name,
    execution: params.execution,
    idempotencyKey: null,
    input: {},
  })

// An inline run lives inside one request. If the isolate carrying it dies, nothing is left to
// close it: it is not running, it was never compensated, and the record says `running` forever.
// A durable run is the opposite — it may legitimately sleep for a week — so the sweep does not
// touch one at any age.
describe('runs nobody is going to finish', () => {
  it('fails an inline run left open longer than the window', async () => {
    let clock = 0
    const journal = createMemoryJournal({ now: () => clock })
    const runId = await openRun(journal, { execution: 'inline', name: 'invoice.create' })

    clock = 10 * minute
    const swept = await sweepAbandonedRuns({
      journal: journal.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(swept).toBe(1)
    expect(journal.runs.find((run) => run.id === runId)?.status).toBe('failed')
  })

  it('says why the run was closed', async () => {
    let clock = 0
    const journal = createMemoryJournal({ now: () => clock })
    await openRun(journal, { execution: 'inline', name: 'invoice.create' })

    clock = 10 * minute
    await sweepAbandonedRuns({
      journal: journal.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(journal.runs[0]?.error).toBe('abandoned: no finish after 300000ms')
  })

  it('leaves an inline run younger than the window alone', async () => {
    let clock = 0
    const journal = createMemoryJournal({ now: () => clock })
    await openRun(journal, { execution: 'inline', name: 'invoice.create' })

    clock = 2 * minute
    const swept = await sweepAbandonedRuns({
      journal: journal.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(swept).toBe(0)
    expect(journal.runs[0]?.status).toBe('running')
  })

  it('leaves a durable run alone however old it is', async () => {
    let clock = 0
    const journal = createMemoryJournal({ now: () => clock })
    await openRun(journal, { execution: 'durable', name: 'invoice.send' })

    clock = 400 * minute
    const swept = await sweepAbandonedRuns({
      journal: journal.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(swept).toBe(0)
    expect(journal.runs[0]?.status).toBe('running')
  })

  it('leaves a run that already ended alone', async () => {
    let clock = 0
    const journal = createMemoryJournal({ now: () => clock })
    const runId = await openRun(journal, { execution: 'inline', name: 'invoice.create' })
    await journal.journal.finishRun({
      tenantId: 'tenant_local',
      runId,
      status: 'completed',
      output: { done: true },
    })

    clock = 10 * minute
    const swept = await sweepAbandonedRuns({
      journal: journal.journal,
      now: clock,
      olderThanMs: 5 * minute,
    })

    expect(swept).toBe(0)
    expect(journal.runs[0]?.status).toBe('completed')
  })

  it('sweeps every tenant, because nobody is asking on their behalf', async () => {
    let clock = 0
    const journal = createMemoryJournal({ now: () => clock })

    for (const tenantId of ['tenant_a', 'tenant_b']) {
      await journal.journal.insertRun({
        tenantId,
        name: 'invoice.create',
        execution: 'inline',
        idempotencyKey: null,
        input: {},
      })
    }

    clock = 10 * minute

    expect(
      await sweepAbandonedRuns({
        journal: journal.journal,
        now: clock,
        olderThanMs: 5 * minute,
      }),
    ).toBe(2)
  })
})
