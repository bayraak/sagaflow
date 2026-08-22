import { stableHash } from './canonical.js'
import { executeRun } from './engine.js'
import { validate } from './schema.js'
import type {
  DurableWorkflowHandle,
  InlineRunResult,
  StandardSchemaV1,
  WorkflowExecution,
  WorkflowHandle,
  WorkflowRuntime,
} from './types.js'

/**
 * The key a run claims, or null when it claims none. Declared here rather than at each executor
 * so both derive it the same way.
 */
export const idempotencyKeyFor = (
  name: string,
  idempotency: true | ((input: never) => string) | undefined,
  input: unknown,
): string | null => {
  if (idempotency === undefined) return null
  if (idempotency === true) return `${name}:${stableHash(input)}`

  return (idempotency as (given: unknown) => string)(input)
}

type WorkflowConfig<Input extends StandardSchemaV1, Execution extends WorkflowExecution> = {
  name: string
  input: Input
  execution: Execution
  /**
   * How this run is recognised as one somebody already asked for.
   *
   * `true` derives the key from the input itself — key order is not meaning, so it is the
   * canonical rendering that is hashed, and the workflow's name is part of the key so two
   * workflows given the same input do not collide. A function is there for when the key means
   * something to somebody else and you want to control it exactly.
   */
  idempotency?: true | ((input: StandardSchemaV1.InferOutput<Input>) => string)
}

export type InlineWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output> = {
  name: string
  execution: 'inline'
  input: Input
  output?: StandardSchemaV1
  idempotency?: true | ((input: StandardSchemaV1.InferOutput<Input>) => string)
  body(input: StandardSchemaV1.InferOutput<Input>, wf: WorkflowHandle<Ctx>): Promise<Output>
  run(options: {
    input: unknown
    ctx: Ctx
    parentRunId?: string | null
  }): Promise<InlineRunResult<Output>>
}

export type DurableWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output> = {
  name: string
  execution: 'durable'
  input: Input
  output?: StandardSchemaV1
  idempotency?: true | ((input: StandardSchemaV1.InferOutput<Input>) => string)
  body(input: StandardSchemaV1.InferOutput<Input>, wf: DurableWorkflowHandle<Ctx>): Promise<Output>
}

export type AnyWorkflow<Ctx extends WorkflowRuntime> =
  | DurableWorkflow<Ctx, StandardSchemaV1, unknown>
  | InlineWorkflow<Ctx, StandardSchemaV1, unknown>

/**
 * An inline definition can run itself — the caller that asked for it is still holding the
 * request open. A durable one cannot: it is started, and an instance runs it later. These two
 * overloads are what make that difference a compile error instead of a convention.
 *
 * Declaring `output` makes the body's return type the schema's, checked at compile time and
 * validated again before the run closes.
 */
export function defineWorkflow<
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Out extends StandardSchemaV1,
>(
  config: WorkflowConfig<Input, 'inline'> & { output: Out },
  body: (
    input: StandardSchemaV1.InferOutput<Input>,
    wf: WorkflowHandle<Ctx>,
  ) => Promise<StandardSchemaV1.InferInput<Out>>,
): InlineWorkflow<Ctx, Input, StandardSchemaV1.InferOutput<Out>>
export function defineWorkflow<
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Out extends StandardSchemaV1,
>(
  config: WorkflowConfig<Input, 'durable'> & { output: Out },
  body: (
    input: StandardSchemaV1.InferOutput<Input>,
    wf: DurableWorkflowHandle<Ctx>,
  ) => Promise<StandardSchemaV1.InferInput<Out>>,
): DurableWorkflow<Ctx, Input, StandardSchemaV1.InferOutput<Out>>
export function defineWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output>(
  config: WorkflowConfig<Input, 'inline'>,
  body: (input: StandardSchemaV1.InferOutput<Input>, wf: WorkflowHandle<Ctx>) => Promise<Output>,
): InlineWorkflow<Ctx, Input, Output>
export function defineWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output>(
  config: WorkflowConfig<Input, 'durable'>,
  body: (
    input: StandardSchemaV1.InferOutput<Input>,
    wf: DurableWorkflowHandle<Ctx>,
  ) => Promise<Output>,
): DurableWorkflow<Ctx, Input, Output>
export function defineWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output>(
  config: WorkflowConfig<Input, WorkflowExecution> & { output?: StandardSchemaV1 },
  body: (
    input: StandardSchemaV1.InferOutput<Input>,
    wf: DurableWorkflowHandle<Ctx>,
  ) => Promise<Output>,
): DurableWorkflow<Ctx, Input, Output> | InlineWorkflow<Ctx, Input, Output> {
  if (config.execution === 'durable') {
    return {
      name: config.name,
      execution: 'durable',
      input: config.input,
      output: config.output,
      idempotency: config.idempotency,
      body,
    }
  }

  // The implementation signature has to accept the richer of the two handles for both
  // overloads to be compatible with it. Reaching the inline branch means the caller matched
  // the inline overload, so the body it wrote can only have asked for the base handle.
  const inlineBody = body as (
    input: StandardSchemaV1.InferOutput<Input>,
    wf: WorkflowHandle<Ctx>,
  ) => Promise<Output>

  const definition: InlineWorkflow<Ctx, Input, Output> = {
    name: config.name,
    execution: 'inline',
    input: config.input,
    output: config.output,
    idempotency: config.idempotency,
    body: inlineBody,
    run: async ({ input, ctx, parentRunId }) => {
      // Validation first, and the run record only after it passes: an input the schema
      // refuses never becomes a run that somebody has to explain.
      const parsed = await validate(config.input, input, `the input of ${config.name}`)
      const idempotencyKey = idempotencyKeyFor(config.name, config.idempotency, parsed)

      let runId: string
      try {
        runId = await ctx.journal.insertRun({
          tenantId: ctx.tenantId,
          name: config.name,
          execution: 'inline',
          idempotencyKey,
          input: parsed,
          parentRunId: parentRunId ?? null,
        })
      } catch (error) {
        // The journal refusing the key IS the dedup signal: the first run already claimed it,
        // so answer with what that run decided instead of doing the work a second time.
        if (idempotencyKey === null) throw error

        const existing = await ctx.journal.findRunByIdempotencyKey({
          tenantId: ctx.tenantId,
          idempotencyKey,
        })
        if (!existing) throw error

        return {
          runId: existing.id,
          output: existing.output,
          status: existing.status,
          deduplicated: true,
        }
      }

      const output = await executeRun<Ctx, Output>({
        name: config.name,
        runId,
        ctx,
        // Inline steps do not retry. The caller is holding a request open, and a saga that
        // cannot finish now should compensate and say so rather than spend the budget.
        runner: (_name, _config, run) => run({ attempt: 1 }),
        invoke: (handle) => inlineBody(parsed, handle),
        ...(config.output === undefined ? {} : { output: config.output }),
      })

      return { runId, output, deduplicated: false }
    },
  }

  return definition
}
