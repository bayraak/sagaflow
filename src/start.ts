import type { DurableWorkflow } from './define'
import { messageOf } from './errors'
import { validate } from './schema'
import type { DurableWorkflowEnv, StandardSchemaV1, WorkflowRuntime } from './types'

const instanceIdReadableLength = 60
const instanceIdDigestLength = 16

const readable = (value: string) =>
  value.replaceAll(/[^a-zA-Z0-9]+/g, '-').slice(0, instanceIdReadableLength)

/**
 * An instance id is how a durable platform recognises work it has already been asked to do, so
 * it has to be derived from the idempotency key AND from the tenant that asked. The key a
 * definition derives sees only the input, and an input can be the same string for every tenant
 * — "the spending report for March" is. An id that left the tenant out would let the first
 * tenant to ask claim the only instance, and every other tenant would be told its work was
 * already under way and never get an answer.
 *
 * The id also has to satisfy `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` within 100 characters, which the
 * keys themselves do not — they carry dots and colons. So the id is the key made readable plus
 * a digest of the tenant and the key exactly as they were written.
 */
export const durableInstanceId = async (name: string, idempotencyKey: string, tenantId: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${tenantId}:${name}:${idempotencyKey}`),
  )
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, instanceIdDigestLength)

  return `wf-${readable(idempotencyKey)}-${hex}`
}

const looksLikeADuplicateInstance = (error: unknown) =>
  /already exists|duplicate/i.test(messageOf(error))

/**
 * The run record is written BEFORE the instance is created, on purpose: if `create` never
 * returns, or the instance dies before its first step, the run still exists to be explained. A
 * workflow that starts without leaving a trace is the one thing a run record cannot allow.
 */
export const startDurableWorkflow = async <
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Output,
>(
  env: DurableWorkflowEnv,
  definition: DurableWorkflow<Ctx, Input, Output>,
  options: { input: unknown; ctx: Ctx; replayOf?: string },
): Promise<{ runId: string; deduplicated: boolean }> => {
  const { ctx } = options
  const parsed = await validate(definition.input, options.input, `the input of ${definition.name}`)

  /*
   * A replay is identified by the RUN it is replaying, never by the input it carries.
   *
   * The distinction is the whole of what makes replay work. Most definitions derive their key
   * from the input, so a replay that kept the definition's own key would arrive at the very key
   * the original run claimed and be answered "already done" — the one answer a replay must
   * never give, because being already done is exactly why somebody is asking. Keying on the run
   * id instead keeps the other guarantee intact: asking for the same replay twice is still one
   * replay, so a caller that retries does not send the same email twice.
   */
  const idempotencyKey =
    options.replayOf === undefined
      ? definition.idempotency
        ? definition.idempotency(parsed)
        : null
      : `replay:${options.replayOf}`

  let runId: string
  try {
    runId = await ctx.journal.insertRun({
      tenantId: ctx.tenantId,
      name: definition.name,
      execution: 'durable',
      idempotencyKey,
      input: parsed,
      ...(options.replayOf === undefined ? {} : { replayOf: options.replayOf }),
    })
  } catch (error) {
    // The journal refused the key, so this work is already under way or already done.
    if (idempotencyKey === null) throw error

    const existing = await ctx.journal.findRunByIdempotencyKey({
      tenantId: ctx.tenantId,
      idempotencyKey,
    })
    if (!existing) throw error

    return { runId: existing.id, deduplicated: true }
  }

  // Deterministic when the definition derives a key, unique when it does not: either way an
  // instance id can be arrived at twice only if the same work was asked for twice.
  const id =
    idempotencyKey === null
      ? `wf-${readable(runId)}`
      : await durableInstanceId(definition.name, idempotencyKey, ctx.tenantId)

  try {
    await env.WORKFLOWS.create({
      id,
      params: {
        name: definition.name,
        tenantId: ctx.tenantId,
        actor: ctx.actor ?? null,
        input: parsed,
        runId,
      },
    })
  } catch (error) {
    await ctx.journal.finishRun({
      tenantId: ctx.tenantId,
      runId,
      status: 'failed',
      error: messageOf(error),
    })

    // An instance under this id already exists — which can only happen once the earlier run
    // record has been swept away — so the work is already running somewhere. This attempt
    // started nothing, and its run record says so.
    if (looksLikeADuplicateInstance(error)) return { runId, deduplicated: true }

    throw error
  }

  return { runId, deduplicated: false }
}
