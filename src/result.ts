import type { SagaError } from './errors.js'
import type { SchemaError } from './schema.js'

/**
 * What a run answers with when the caller would rather decide than catch.
 *
 * A saga that was undone is a normal outcome — the undo ran, the record is written, and there is
 * a decision to make. Requiring a try/catch and an `instanceof` to reach it makes the ordinary
 * case look like the broken one.
 *
 * The shape is deliberately the one every Result library in TypeScript already uses, so wrapping
 * it in yours is one line and depending on any of them is nobody's problem but yours.
 *
 * `error` is a `SagaError` whenever a run was opened, carrying the whole trail: the run, the
 * outcome, the step that failed, which undos came back and which refused. It is a `SchemaError`
 * when the input was refused, because in that case there is no run to report on.
 */
export type TryRunResult<Output> =
  | { ok: true; value: Output; runId: string; deduplicated: boolean }
  | { ok: false; error: SagaError | SchemaError }
