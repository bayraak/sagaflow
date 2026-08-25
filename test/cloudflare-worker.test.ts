import { describe, expect, it } from 'bun:test'

import { handleScheduled } from '../src/cloudflare/worker'
import { createMemoryJournal } from '../src/memory/index'

const minute = 60_000

// A cron hands the handler the moment it fired for. The sweeps read THAT clock, so a run
// opened an hour from now is abandoned when the cron says it is eleven minutes later —
// and left alone when the handler is given no controller and falls back to the wall clock.
describe("the scheduled handler and the cron's own clock", () => {
  const openInTheFuture = async () => {
    const opened = Date.now() + 60 * minute
    const journal = createMemoryJournal({ now: () => opened })
    const runId = await journal.journal.insertRun({
      tenantId: 'tenant_local',
      name: 'invoice.create',
      execution: 'inline',
      idempotencyKey: null,
      input: {},
    })

    return { journal, runId, opened }
  }

  it('sweeps by the scheduledTime the controller carries', async () => {
    const { journal, runId, opened } = await openInTheFuture()
    const scheduled = handleScheduled(
      { runtime: { journal: journal.journal, events: undefined } } as never,
      { abandonedAfterMs: 10 * minute },
    )

    await scheduled({ scheduledTime: opened + 11 * minute, cron: '*/5 * * * *' })

    expect(journal.runs.find((run) => run.id === runId)?.status).toBe('failed')
  })

  it('falls back to the wall clock without a controller', async () => {
    const { journal, runId } = await openInTheFuture()
    const scheduled = handleScheduled(
      { runtime: { journal: journal.journal, events: undefined } } as never,
      { abandonedAfterMs: 10 * minute },
    )

    await scheduled()

    expect(journal.runs.find((run) => run.id === runId)?.status).toBe('running')
  })
})
