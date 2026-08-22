import { compensatedEnvelope } from './events.js'
import { envelopeId } from './identity.js'
import type { RunJournal } from './types.js'

/** How many abandoned runs one sweep closes. The next sweep takes the rest. */
export const abandonedSweepLimit = 200

/**
 * Close the runs nobody is going to close.
 *
 * An inline run lives inside one request. If the process carrying it dies — a deploy, a crash,
 * a timeout — nothing is left to finish it: it is not running, it was never compensated, and
 * the record says `running` for as long as the table exists. Those are the runs an operator
 * finds a year later and cannot explain, and the only honest thing to do with them is say so.
 *
 * Durable runs are deliberately not touched at any age. One may be asleep for a week or waiting
 * on a human, and failing it because it is old would be the sweep inventing an incident rather
 * than reporting one.
 *
 * Each run is closed through `finishRun` carrying its own announcement, because every closed
 * run announces itself and a sweeper is not an exception to that. A bulk update would be one
 * round trip instead of N and would leave a consumer counting runs quietly short.
 *
 * Answers how many runs it closed. Run it on a schedule with a window comfortably longer than
 * your longest inline request.
 */
export const sweepAbandonedRuns = async (options: {
  journal: RunJournal
  now?: number
  olderThanMs: number
  limit?: number
}): Promise<number> => {
  const error = `abandoned: no finish after ${options.olderThanMs}ms`

  const abandoned = await options.journal.listAbandonedRuns({
    execution: 'inline',
    startedBefore: (options.now ?? Date.now()) - options.olderThanMs,
    limit: options.limit ?? abandonedSweepLimit,
  })

  for (const run of abandoned) {
    await options.journal.finishRun({
      tenantId: run.tenantId,
      runId: run.runId,
      status: 'failed',
      error,
      // The run emitted nothing — it never reached its finish — so the announcement is the
      // first envelope this run has ever produced, and takes the first ordinal.
      events: [
        compensatedEnvelope({
          runId: run.runId,
          name: run.name,
          tenantId: run.tenantId,
          actor: null,
          error,
          outcome: 'failed',
          id: envelopeId(run.runId, 0),
        }),
      ],
    })
  }

  return abandoned.length
}
