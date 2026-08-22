import { envelopeId } from './identity'
import { validateSync } from './schema'
import type { EventEnvelope, EventSchemaMap, LifecycleEventType } from './types'

/**
 * Facts the engine states about the run itself, declared once. `LifecycleEventPayloads` in
 * types.ts is keyed off this object, so a name added here has to be given a payload there and
 * cannot be added in one place and forgotten in the other.
 *
 * A body never emits these — it is refused if it tries — and a consumer can rely on seeing
 * exactly one of them per closed run.
 */
export const lifecycleEvents = {
  completed: 'workflow.completed',
  compensated: 'workflow.compensated',
} as const

export const lifecycleEventTypes: ReadonlyArray<LifecycleEventType> = Object.values(lifecycleEvents)

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
  // The engine states exactly one fact about every run it closes. A body emitting the same type
  // would put a second one on the table, and anything counting runs from the stream — an audit
  // log, a metrics mirror — would quietly count wrong. The name belongs to the engine, like the
  // step names it uses for itself.
  if (isLifecycleEvent(type)) {
    throw new Error(`"${type}" is emitted by the engine and cannot be emitted by a workflow`)
  }

  if (!schemas) return payload

  const schema = schemas[type]
  if (!schema) throw new Error(`no event schema is declared for "${type}"`)

  return validateSync(schema, payload, `the payload of "${type}"`)
}

/**
 * A raw emission, before the engine has decided where in the run it sits. A step's emissions
 * travel home inside its memoised result, so they must be plain data — the id is assigned by
 * the engine afterwards, from a counter that a replay arrives at the same way.
 */
export type RawEvent = { type: string; payload: unknown }

/**
 * The id is the run and the emission's position in it, never a random one. That is what makes
 * a second write of the same run's events land on the rows that already exist instead of
 * handing the consumer a copy it has never seen an id for.
 */
export const createEnvelope = (options: {
  type: string
  payload: unknown
  tenantId: string
  actor: string | null
  runId: string
  ordinal: number
}): EventEnvelope => ({
  id: envelopeId(options.runId, options.ordinal),
  type: options.type,
  payload: options.payload,
  tenantId: options.tenantId,
  actor: options.actor,
  runId: options.runId,
  occurredAt: Date.now(),
})
