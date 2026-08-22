import type { EventEnvelope, EventSink, RunJournal } from './types.js'

/**
 * What one batched send carries. A drain larger than this is more than one call, and the
 * number lives here — beside the only code that makes those calls — rather than in a journal,
 * which has no business knowing what a queue is.
 */
export const eventBatchLimit = 100

/**
 * The one way an event leaves the process, shared by the drain a run does for itself and the
 * sweep a cron does for whatever the drain could not finish. Sending and recording the send
 * are one act per batch: a batch that was sent but not recorded is sent again by the next
 * sweep, which the consumer recognises by the envelope's id and discards — the safe direction
 * of an at-least-once delivery.
 */
export const dispatchEvents = async (options: {
  sink: EventSink
  envelopes: EventEnvelope[]
  markDispatched: (ids: string[]) => Promise<void>
}): Promise<number> => {
  let delivered = 0

  for (let index = 0; index < options.envelopes.length; index += eventBatchLimit) {
    const batch = options.envelopes.slice(index, index + eventBatchLimit)

    await options.sink.sendBatch(batch.map((body) => ({ body })))
    await options.markDispatched(batch.map((message) => message.id))

    delivered += batch.length
  }

  return delivered
}

/**
 * How many rows one sweep considers. A sweep is a background job on a schedule, so it takes a
 * bounded bite and lets the next one take the rest rather than holding a connection open over
 * a backlog.
 */
export const eventSweepLimit = 500

/**
 * How long a row is left for the run that made it. A row written a moment ago almost certainly
 * belongs to a run whose own drain is still in flight; waiting a minute costs a minute and
 * saves a duplicate delivery.
 */
export const eventSweepGraceMs = 60_000

/**
 * The other half of the outbox: what comes back for the events a run's own drain could not
 * deliver. The drain is best-effort by design — the mutation committed, and a queue that could
 * not be reached is not the caller's problem — and this is what makes that true.
 *
 * It reads across every tenant, because nobody is asking on a tenant's behalf, and delivers
 * each tenant's rows under that tenant so a journal that scopes its writes still can.
 *
 * `olderThanMs` leaves the youngest rows alone: one written a moment ago probably belongs to a
 * run whose own drain is still in flight, and waiting for the next sweep costs a few minutes
 * and saves a duplicate delivery. Run it on a schedule; it is idempotent, and a row delivered
 * twice is a message the consumer recognises by its id.
 */
export const sweepEventOutbox = async (options: {
  journal: RunJournal
  sink: EventSink
  now?: number
  olderThanMs?: number
  limit?: number
}): Promise<number> => {
  const stranded = await options.journal.listUndispatchedEvents({
    before: (options.now ?? Date.now()) - (options.olderThanMs ?? eventSweepGraceMs),
    limit: options.limit ?? eventSweepLimit,
  })

  const byTenant = new Map<string, EventEnvelope[]>()
  for (const row of stranded) {
    const carried = byTenant.get(row.tenantId) ?? []
    carried.push(row.envelope)
    byTenant.set(row.tenantId, carried)
  }

  let delivered = 0
  for (const [tenantId, envelopes] of byTenant) {
    delivered += await dispatchEvents({
      sink: options.sink,
      envelopes,
      markDispatched: (ids) => options.journal.markEventsDispatched({ tenantId, ids }),
    })
  }

  return delivered
}
