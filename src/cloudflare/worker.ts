import type { Flow } from '../flow.js'
import { sweepEventOutbox } from '../outbox.js'
import { sweepAbandonedRuns } from '../sweep.js'
import type { EventEnvelope, EventSchemaMap } from '../types.js'

export type QueueOptions = {
  /** What to do with each event. Without one, a delivered message is only acknowledged. */
  onEvent?(envelope: EventEnvelope): Promise<void> | void
  /**
   * Whether this envelope has been seen before. Delivery is at-least-once, so a consumer that
   * does anything a second delivery would repeat needs one of these — usually a unique index on
   * the envelope id in whatever table the consumer writes.
   */
  seen?(id: string): Promise<boolean> | boolean
}

export type SweepOptions = {
  /** How long a row is left for the run that made it. Defaults to a minute. */
  outboxOlderThanMs?: number
  /** How long an inline run may be open before it is declared abandoned. Defaults to 15 minutes. */
  abandonedAfterMs?: number
}

const defaultAbandonedAfterMs = 15 * 60_000

/**
 * The queue consumer, for the events the outbox delivers.
 *
 * Each message is acknowledged or retried on its own: one message the consumer cannot handle
 * does not send the other nine round again. A message whose id has been seen is acknowledged
 * without being handled, because at-least-once delivery means a repeat is expected rather than
 * exceptional.
 */
export const handleQueue =
  (options: QueueOptions = {}) =>
  async (batch: { messages: { body: unknown; ack(): void; retry(): void }[] }): Promise<void> => {
    for (const message of batch.messages) {
      try {
        const envelope = message.body as EventEnvelope

        if (options.seen && (await options.seen(envelope.id))) {
          message.ack()
          continue
        }

        await options.onEvent?.(envelope)
        message.ack()
      } catch {
        message.retry()
      }
    }
  }

/**
 * The scheduled handler: both sweepers, on whatever cron you point at it.
 *
 * They are separate concerns with the same shape — one carries the events a drain could not
 * deliver, the other closes inline runs whose process died — and there is no reason to make
 * anybody wire two handlers for them.
 */
export const handleScheduled =
  <Events extends EventSchemaMap>(flow: Flow<Events>, options: SweepOptions = {}) =>
  async (): Promise<void> => {
    const journal = flow.runtime.journal
    const sink = flow.runtime.events

    if (sink) {
      await sweepEventOutbox({
        journal,
        sink,
        ...(options.outboxOlderThanMs === undefined
          ? {}
          : { olderThanMs: options.outboxOlderThanMs }),
      })
    }

    await sweepAbandonedRuns({
      journal,
      olderThanMs: options.abandonedAfterMs ?? defaultAbandonedAfterMs,
    })
  }

/**
 * The whole module worker, given an instance and your fetch handler.
 *
 * Everything else a sagaflow worker needs — draining the outbox to a consumer, sweeping what the
 * drain could not deliver, closing runs nobody was left to finish — is the same in every worker
 * that uses this library, so it is written once here rather than copied into each one.
 */
export const workerFor = <Events extends EventSchemaMap>(
  flow: Flow<Events>,
  options: { fetch?: ExportedHandlerFetchHandler } & QueueOptions & SweepOptions = {},
): {
  fetch?: ExportedHandlerFetchHandler
  queue: ReturnType<typeof handleQueue>
  scheduled: ReturnType<typeof handleScheduled>
} => ({
  ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  queue: handleQueue(options),
  scheduled: handleScheduled(flow, options),
})
