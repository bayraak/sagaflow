import { validateSync } from './schema'
import type { EventEnvelope, EventSchemaMap, LifecycleEventPayloads } from './types'

export const workflowCompletedEvent = 'workflow.completed'

/**
 * Facts the engine states about the run itself. A body never has to emit these, and a
 * consumer can rely on seeing exactly one of them per closed run.
 */
export const lifecycleEventTypes: ReadonlyArray<keyof LifecycleEventPayloads> = [
  workflowCompletedEvent,
]

const isLifecycleEvent = (type: string): boolean =>
  (lifecycleEventTypes as ReadonlyArray<string>).includes(type)

/**
 * A declared map is a promise that every event has a shape, so a type that is missing from it
 * is a mistake rather than an escape hatch — the exception being the lifecycle facts, which
 * the package declares and the caller never has to.
 */
export const validateEmission = (
  schemas: EventSchemaMap | undefined,
  type: string,
  payload: unknown,
): unknown => {
  if (!schemas) return payload

  const schema = schemas[type]
  if (!schema) {
    if (isLifecycleEvent(type)) return payload

    throw new Error(`no event schema is declared for "${type}"`)
  }

  return validateSync(schema, payload, `the payload of "${type}"`)
}

export const createEnvelope = (options: {
  type: string
  payload: unknown
  tenantId: string
  actor: string | null
  runId: string
}): EventEnvelope => ({
  id: crypto.randomUUID(),
  type: options.type,
  payload: options.payload,
  tenantId: options.tenantId,
  actor: options.actor,
  runId: options.runId,
  occurredAt: Date.now(),
})
