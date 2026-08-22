import { describe, expect, it } from 'bun:test'

import { sweepEventOutbox, type EventEnvelope } from '../src/index.js'
import { createMemoryJournal, createMemorySink } from '../src/memory/index'

const envelope = (options: {
  tenantId: string
  ordinal: number
  occurredAt: number
}): EventEnvelope => ({
  id: `run_1:${options.ordinal}`,
  type: 'invoice.issued',
  payload: { invoiceId: `INV-${options.ordinal}` },
  tenantId: options.tenantId,
  actor: null,
  runId: 'run_1',
  occurredAt: options.occurredAt,
})

const withStrandedEvents = async (events: EventEnvelope[]) => {
  const journal = createMemoryJournal()

  for (const [index, event] of events.entries()) {
    await journal.journal.finishRun({
      tenantId: event.tenantId,
      runId: `run_${index}`,
      status: 'completed',
      events: [event],
    })
  }

  return journal
}

// The drain a run does for itself is best-effort by design: the mutation committed, and a
// queue that could not be reached is not the caller's problem. This is what makes that true —
// the rows are on the table, and something comes back for them.
describe('sweeping the events a drain could not deliver', () => {
  it('delivers what is waiting and says how much', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 10 }),
      envelope({ tenantId: 'tenant_a', ordinal: 1, occurredAt: 20 }),
    ])
    const { sink, sent } = createMemorySink()

    const delivered = await sweepEventOutbox({ journal: journal.journal, sink, now: 100_000 })

    expect(delivered).toBe(2)
    expect(sent.map((message) => message.id)).toEqual(['run_1:0', 'run_1:1'])
  })

  it('stamps what it delivered so nothing sweeps it twice', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 10 }),
    ])
    const { sink } = createMemorySink()

    await sweepEventOutbox({ journal: journal.journal, sink, now: 100_000 })
    const second = await sweepEventOutbox({
      journal: journal.journal,
      sink: createMemorySink().sink,
      now: 100_000,
    })

    expect(journal.dispatched).toEqual(['run_1:0'])
    expect(second).toBe(0)
  })

  // Every tenant at once, because nobody is asking on a tenant's behalf — but each tenant's
  // rows are stamped under their own tenant, so a journal that scopes its writes can.
  it('carries every tenant, one batch each', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 10 }),
      envelope({ tenantId: 'tenant_b', ordinal: 1, occurredAt: 20 }),
    ])
    const { sink, batches } = createMemorySink()

    const delivered = await sweepEventOutbox({ journal: journal.journal, sink, now: 100_000 })

    expect(delivered).toBe(2)
    expect(batches.map((batch) => batch.map((message) => message.tenantId))).toEqual([
      ['tenant_a'],
      ['tenant_b'],
    ])
  })

  // A row written a moment ago probably belongs to a run whose own drain is still in flight.
  // Leaving it for the next sweep costs a few minutes and saves a duplicate delivery.
  it('leaves rows younger than the window for the run that made them, by default too', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 100 }),
      envelope({ tenantId: 'tenant_a', ordinal: 1, occurredAt: 990 }),
    ])
    const { sink, sent } = createMemorySink()

    const delivered = await sweepEventOutbox({
      journal: journal.journal,
      sink,
      now: 1000,
      olderThanMs: 500,
    })

    expect(delivered).toBe(1)
    expect(sent.map((message) => message.id)).toEqual(['run_1:0'])
  })

  it('takes no more than it was asked to', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 10 }),
      envelope({ tenantId: 'tenant_a', ordinal: 1, occurredAt: 20 }),
      envelope({ tenantId: 'tenant_a', ordinal: 2, occurredAt: 30 }),
    ])
    const { sink } = createMemorySink()

    expect(await sweepEventOutbox({ journal: journal.journal, sink, now: 100_000, limit: 2 })).toBe(
      2,
    )
  })

  // A sink that is still down leaves everything exactly where it was, for the next sweep.
  it('stamps nothing when the sink is still unreachable', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 10 }),
    ])
    const { sink } = createMemorySink({ refuses: true })

    const delivered = await sweepEventOutbox({
      journal: journal.journal,
      sink,
      now: 100_000,
    }).catch(() => -1)

    expect(delivered).toBe(-1)
    expect(journal.dispatched).toEqual([])
  })
})

// The default matters more than the option: most callers will never pass a window, and a sweep
// that raced every run's own drain would double-deliver on a healthy system rather than a
// broken one.
describe('the default grace period', () => {
  it('leaves a row written a moment ago for the drain that is probably still going', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 99_990 }),
    ])
    const { sink } = createMemorySink()

    expect(await sweepEventOutbox({ journal: journal.journal, sink, now: 100_000 })).toBe(0)
  })

  it('carries it once it is a minute old', async () => {
    const journal = await withStrandedEvents([
      envelope({ tenantId: 'tenant_a', ordinal: 0, occurredAt: 30_000 }),
    ])
    const { sink } = createMemorySink()

    expect(await sweepEventOutbox({ journal: journal.journal, sink, now: 100_000 })).toBe(1)
  })
})
