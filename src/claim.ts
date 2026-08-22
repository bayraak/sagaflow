import { IdempotencyKeyHeldError } from './errors'
import type { RunJournal, RunStatus } from './types'

export type RunClaim =
  | { claimed: true; runId: string }
  | { claimed: false; runId: string; status: RunStatus; output: unknown }

/**
 * Opening a run, or finding out who already did.
 *
 * The journal refusing the insert IS the dedup signal — that is why `insertRun` is specified to
 * throw rather than to answer politely. Both executors need the same answer to the same
 * question, so they ask it here.
 *
 * The retry covers a real race: between the refusal and the lookup, the run that held the key
 * can finish badly and release it, leaving nobody holding a key that was just refused. Asking
 * again is correct exactly once — a second refusal with nobody holding it would mean something
 * else is wrong, and that is worth surfacing.
 */
export const claimRun = async (options: {
  journal: RunJournal
  tenantId: string
  idempotencyKey: string | null
  insert: () => Promise<string>
}): Promise<RunClaim> => {
  try {
    return { claimed: true, runId: await options.insert() }
  } catch (error) {
    const { idempotencyKey } = options
    if (idempotencyKey === null) throw error

    const holder = await options.journal.findRunByIdempotencyKey({
      tenantId: options.tenantId,
      idempotencyKey,
    })

    if (holder) {
      return { claimed: false, runId: holder.id, status: holder.status, output: holder.output }
    }

    // A journal that names its refusal is unambiguous: the key WAS held, and is not now. Any
    // other error might be the store being unreachable, and answering that with a second write
    // would be guessing.
    if (!(error instanceof IdempotencyKeyHeldError)) throw error

    return { claimed: true, runId: await options.insert() }
  }
}
