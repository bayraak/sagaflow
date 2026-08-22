import { SagaflowError } from './errors.js'
import type { RunJournal } from './types.js'

/**
 * What the engine throws when it finds that the run has been asked to stop. It is not a
 * failure: the run is unwound exactly as a failure would be, but it closes `cancelled` and
 * says so, because "somebody changed their mind" and "something broke" are different facts.
 */
export class WorkflowCancelledError extends SagaflowError {
  readonly runId: string

  constructor(runId: string) {
    super(`run ${runId} was asked to stop`)

    this.name = 'WorkflowCancelledError'
    this.runId = runId
  }
}

/**
 * Ask a run to stop. Cooperative, and deliberately so: the engine cannot interrupt somebody
 * else's code mid-step, and a library that claimed otherwise would be making the dangerous
 * kind of promise. The request is a flag on the run record; the engine reads it back from the
 * value `recordStep` returns, so noticing it costs no extra round trip, and it takes effect at
 * the next step boundary.
 *
 * Answers true only if the run was running. A run that has already ended cannot be stopped,
 * and saying so is more useful than pretending.
 */
export const requestCancellation = (options: {
  journal: RunJournal
  tenantId: string
  runId: string
}): Promise<boolean> =>
  options.journal.requestCancellation({ tenantId: options.tenantId, runId: options.runId })
