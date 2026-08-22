import type { RunJournal } from './types'

/**
 * Close the runs nobody is going to close.
 *
 * An inline run lives inside one request. If the isolate carrying it dies — a deploy, a crash,
 * a timeout — nothing is left to finish it: it is not running, it was never compensated, and
 * the record says `running` for as long as the table exists. Those are the runs an operator
 * finds a year later and cannot explain, and the only honest thing to do with them is say so.
 *
 * Durable runs are deliberately not touched at any age. One may be asleep for a week or
 * waiting on a human, and failing it because it is old would be the sweep inventing an
 * incident rather than reporting one.
 *
 * Answers how many runs it closed. Run it on a schedule with a window comfortably longer than
 * your longest inline request.
 */
export const sweepAbandonedRuns = (options: {
  journal: RunJournal
  now?: number
  olderThanMs: number
}): Promise<number> =>
  options.journal.failAbandonedRuns({
    execution: 'inline',
    startedBefore: (options.now ?? Date.now()) - options.olderThanMs,
    error: `abandoned: no finish after ${options.olderThanMs}ms`,
  })
