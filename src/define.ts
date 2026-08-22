import { executeRun } from './engine'
import { validate } from './schema'
import type {
  DurableWorkflowHandle,
  InlineRunResult,
  StandardSchemaV1,
  WorkflowExecution,
  WorkflowHandle,
  WorkflowRuntime,
} from './types'

type WorkflowConfig<Input extends StandardSchemaV1, Execution extends WorkflowExecution> = {
  name: string
  input: Input
  execution: Execution
  idempotency?: (input: StandardSchemaV1.InferOutput<Input>) => string
}

export type InlineWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output> = {
  name: string
  execution: 'inline'
  input: Input
  idempotency?: (input: StandardSchemaV1.InferOutput<Input>) => string
  body: (input: StandardSchemaV1.InferOutput<Input>, wf: WorkflowHandle<Ctx>) => Promise<Output>
  run: (options: { input: unknown; ctx: Ctx }) => Promise<InlineRunResult<Output>>
}

export type DurableWorkflow<Ctx extends WorkflowRuntime, Input extends StandardSchemaV1, Output> = {
  name: string
  execution: 'durable'
  input: Input
  idempotency?: (input: StandardSchemaV1.InferOutput<Input>) => string
  body: (
    input: StandardSchemaV1.InferOutput<Input>,
    wf: DurableWorkflowHandle<Ctx>,
  ) => Promise<Output>
}

export type AnyWorkflow<Ctx extends WorkflowRuntime> =
  | DurableWorkflow<Ctx, StandardSchemaV1, unknown>
  | InlineWorkflow<Ctx, StandardSchemaV1, unknown>

/**
 * An inline definition can run itself — the caller that asked for it is still holding the
 * request open. A durable one cannot: it is started, and an instance runs it later. These two
 * overloads are what make that difference a compile error instead of a convention.
 */
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
  config: WorkflowConfig<Input, WorkflowExecution>,
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
    idempotency: config.idempotency,
    body: inlineBody,
    run: async ({ input, ctx }) => {
      // Validation first, and the run record only after it passes: an input the schema
      // refuses never becomes a run that somebody has to explain.
      const parsed = await validate(config.input, input, `the input of ${config.name}`)
      const idempotencyKey = config.idempotency ? config.idempotency(parsed) : null

      let runId: string
      try {
        runId = await ctx.journal.insertRun({
          tenantId: ctx.tenantId,
          name: config.name,
          execution: 'inline',
          idempotencyKey,
          input: parsed,
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
      })

      return { runId, output, deduplicated: false }
    },
  }

  return definition
}
