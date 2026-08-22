import type { EventEnvelope, EventSink } from './types'

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
