import type { CompensationOutcome } from './types'

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * What a failed run throws. It carries the run id because the run record — not the stack — is
 * where the failure is explained: input, step trail, compensation trail, timings.
 */
export class WorkflowError extends Error {
  readonly runId: string
  readonly workflowName: string
  readonly stepName: string | null
  readonly outcome: CompensationOutcome

  constructor(params: {
    runId: string
    workflowName: string
    stepName: string | null
    outcome: CompensationOutcome
    cause: unknown
  }) {
    super(
      `workflow ${params.workflowName} failed at ${params.stepName ?? 'its body'} and ${params.outcome === 'compensated' ? 'was compensated' : 'could not be fully compensated'}: ${messageOf(params.cause)}`,
      { cause: params.cause },
    )

    this.name = 'WorkflowError'
    this.runId = params.runId
    this.workflowName = params.workflowName
    this.stepName = params.stepName
    this.outcome = params.outcome
  }
}
