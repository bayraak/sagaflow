import { claimRun } from './claim.js'
import { idempotencyKeyFor, type DurableWorkflow } from './define.js'
import { messageOf } from './errors.js'
import { compensatedEnvelope } from './events.js'
import { validate } from './schema.js'
import type { StandardSchemaV1, WorkflowLauncher, WorkflowRuntime } from './types.js'

const instanceIdPrefix = 'wf-'
const instanceIdLimit = 100

// Underscores survive because the platforms allow them and because a run id is far more
// useful when it is the run id verbatim.
const readable = (value: string): string => value.replaceAll(/[^a-zA-Z0-9_]+/g, '-')

/**
 * The id a durable instance is created under: the workflow's name, made legal, and the run it
 * belongs to.
 *
 * It used to be a digest of the tenant and the idempotency key, which quietly made the
 * platform a SECOND dedup authority beside the run record — and the two disagreed the moment a
 * run record was swept away. The key was free, the instance id was not, and the work could
 * never be asked for again. There is one authority now, the run record, and an instance is
 * simply named after the run it is carrying out.
 *
 * Cloudflare Workflows accepts `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` within 100 characters, and the
 * run id is what has to survive truncation, so the name is what gives way.
 */
export const instanceIdFor = (name: string, runId: string): string => {
  const suffix = `-${readable(runId)}`
  const room = instanceIdLimit - instanceIdPrefix.length - suffix.length

  return `${instanceIdPrefix}${readable(name).slice(0, Math.max(room, 0))}${suffix}`
}

/**
 * The run record is written BEFORE the instance is created, on purpose: if `create` never
 * returns, or the instance dies before its first step, the run still exists to be explained. A
 * workflow that starts without leaving a trace is the one thing a run record cannot allow.
 */
export const startDurableWorkflow = async <
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Output,
>(options: {
  /**
   * The binding itself, not an environment that happens to hold one under a fixed key. A worker
   * may have several workflow bindings, and which one a definition belongs on is the caller's
   * business rather than a naming convention this package imposes.
   */
  launcher: WorkflowLauncher
  definition: DurableWorkflow<Ctx, Input, Output>
  input: unknown
  ctx: Ctx
  replayOf?: string
  parentRunId?: string | null
}): Promise<{ runId: string; deduplicated: boolean }> => {
  const { ctx, definition } = options
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
      ? idempotencyKeyFor(definition.name, definition.idempotency, parsed)
      : `replay:${options.replayOf}`

  const claim = await claimRun({
    journal: ctx.journal,
    tenantId: ctx.tenantId,
    idempotencyKey,
    insert: () =>
      ctx.journal.insertRun({
        tenantId: ctx.tenantId,
        name: definition.name,
        execution: 'durable',
        idempotencyKey,
        input: parsed,
        parentRunId: options.parentRunId ?? null,
        ...(options.replayOf === undefined ? {} : { replayOf: options.replayOf }),
      }),
  })

  // Already under way, or already done. Answer with the run that is doing it.
  if (!claim.claimed) return { runId: claim.runId, deduplicated: true }

  const { runId } = claim

  try {
    await options.launcher.create({
      id: instanceIdFor(definition.name, runId),
      params: {
        name: definition.name,
        tenantId: ctx.tenantId,
        actor: ctx.actor ?? null,
        input: parsed,
        runId,
      },
    })
  } catch (error) {
    // The run record exists and nothing is going to carry it out, so it is closed here — and
    // closed the way every other run is, with the announcement that says so. A run that ended
    // in silence is a run a consumer counting them never hears about.
    await ctx.journal.finishRun({
      tenantId: ctx.tenantId,
      runId,
      status: 'failed',
      error: messageOf(error),
      events: [
        compensatedEnvelope({
          runId,
          name: definition.name,
          tenantId: ctx.tenantId,
          actor: ctx.actor ?? null,
          error: messageOf(error),
          outcome: 'failed',
          // The instance never existed, so this run has emitted nothing else.
          ordinal: 0,
        }),
      ],
    })

    // Whatever the platform refused for, this attempt started nothing and its run record says
    // so. There is no case here for reading a refusal as success: the id belongs to this run
    // alone, so a platform reporting a duplicate is reporting something impossible.
    throw error
  }

  return { runId, deduplicated: false }
}
