import type { CompensationOutcome } from './types.js'

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * The ancestor of everything this library throws, so one `catch` can recognise all of it.
 *
 * Without it a caller has to know every concrete name, and every error type added in a later
 * version silently walks past the catch block somebody wrote carefully. With it, a new error
 * type is an additive change.
 */
export class SagaflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)

    this.name = 'SagaflowError'
  }
}

const describeFailure = (params: {
  workflowName: string
  stepName: string | null
  outcome: CompensationOutcome
  cause: unknown
}): string => {
  const where = params.stepName ?? 'its body'

  if (params.outcome === 'cancelled') {
    return `workflow ${params.workflowName} was cancelled at ${where} and was fully undone`
  }

  return `workflow ${params.workflowName} failed at ${where} and ${params.outcome === 'compensated' ? 'was compensated' : 'could not be fully compensated'}: ${messageOf(params.cause)}`
}

/**
 * What a failed run throws. It carries the run id because the run record — not the stack — is
 * where the failure is explained: input, step trail, compensation trail, timings.
 */
export class WorkflowError extends SagaflowError {
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
    super(describeFailure(params), { cause: params.cause })

    this.name = 'WorkflowError'
    this.runId = params.runId
    this.workflowName = params.workflowName
    this.stepName = params.stepName
    this.outcome = params.outcome
  }
}

/**
 * What a journal throws when the idempotency key is already held.
 *
 * A typed refusal rather than a message to match on: a journal built on a store this package
 * has never heard of can say "this key is taken" unambiguously, and the engine can tell that
 * apart from the database being on fire. Journals that throw something else still work — the
 * engine asks who holds the key before deciding — but they give it less to go on.
 */
export class IdempotencyKeyHeldError extends SagaflowError {
  readonly tenantId: string
  readonly idempotencyKey: string

  constructor(params: { tenantId: string; idempotencyKey: string }) {
    super(`the idempotency key "${params.idempotencyKey}" is already held`)

    this.name = 'IdempotencyKeyHeldError'
    this.tenantId = params.tenantId
    this.idempotencyKey = params.idempotencyKey
  }
}
