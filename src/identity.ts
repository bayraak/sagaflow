/**
 * The two identities the engine mints, declared once.
 *
 * Both are derived from the run rather than from the clock or a random source, and that is the
 * whole point: a durable body invoked twice for one run walks the same steps and the same
 * emissions in the same order, so it arrives at the same identities. A second write then lands
 * on the rows that already exist instead of handing a consumer copies it has no way to
 * recognise, and a step retried after a provider already accepted the work presents the same
 * key it presented the first time.
 *
 * They are here, together, because they are a wire format: they appear in database rows, in
 * delivered messages and in other people's idempotency records, so changing either is a
 * breaking change and the two must never quietly drift apart.
 */

/** What a step presents to the outside world. Stable across attempts and replays. */
export const stepIdempotencyKey = (runId: string, seq: number): string => `${runId}:${seq}`

/**
 * What a compensation presents. Undoing a charge is a refund — a different side effect, and so
 * a different key, derived from the step it reverses.
 */
export const compensationIdempotencyKey = (runId: string, seq: number): string =>
  `${runId}:${seq}:undo`

/** What identifies one emission of one run, to the outbox and to every consumer. */
export const envelopeId = (runId: string, ordinal: number): string => `${runId}:${ordinal}`
