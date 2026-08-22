import type { DurableWorkflow } from './define.js'
import { executeRun } from './engine.js'
import { SagaError, SagaflowError } from './errors.js'
import { validate } from './schema.js'
import { compensationPrefix } from './step.js'
import type {
  CompensationOutcome,
  DurableWorkflowHandle,
  RunJournal,
  StandardSchemaV1,
  StepPrimitive,
  WorkflowRuntime,
} from './types.js'

type Entry = { closed: false } | { closed: true; status: string; output: unknown }

/*
 * What the platform is allowed to run, before it runs anything.
 *
 * A durable instance can be invoked again for a run that has already been closed — the finish
 * batch commits, the instance dies before the platform checkpoints `finish-run`, and the next
 * invocation starts from the top. Replaying memoised steps is harmless; walking PAST the point
 * where the first invocation stopped is not, and the body can, because a memoised step never
 * calls `recordStep` and so never re-reads the cancellation flag that stopped it.
 *
 * So the run is read once, at the top of every durable invocation. One read; none at all for an
 * inline run, which cannot be re-invoked. A journal that cannot read a run back is not blocked
 * from working — the guard is skipped, and the residual is documented.
 */
const entryStateOf = async (
  journal: RunJournal,
  tenantId: string,
  runId: string,
): Promise<Entry> => {
  if (!journal.getRun) return { closed: false }

  const run = await journal.getRun({ tenantId, runId })

  // No record is not a closed record. A run whose row has been swept away is not a run that
  // ended; refusing to carry it out would be inventing an outcome nobody wrote down.
  if (!run || run.status === 'running') return { closed: false }

  return { closed: true, status: run.status, output: run.output }
}

/*
 * What the run's trail says, read once, before this invocation runs anything.
 *
 * Two facts come out of the same read. An undo recorded as REFUSED is final: a refused undo is
 * not checkpointed, so without this the next invocation simply tries it again — after the undos
 * that came later in reverse order have already succeeded. And a trail that holds ANY
 * compensation says the run had begun unwinding, which is the point past which the body must
 * not be carried forward.
 *
 * Skipped by a journal that cannot read a trail back: such a journal keeps the older behaviour
 * rather than being refused service, and the residual is documented.
 */
const trailAtEntry = async (
  journal: RunJournal,
  tenantId: string,
  runId: string,
): Promise<{
  refused: ReadonlySet<string>
  completedSteps: ReadonlySet<string>
  unwindingBegan: boolean
}> => {
  if (!journal.listRunSteps) {
    return { refused: new Set(), completedSteps: new Set(), unwindingBegan: false }
  }

  const trail = await journal.listRunSteps({ tenantId, runId })
  const compensations = trail.filter((entry) => entry.name.startsWith(compensationPrefix))

  return {
    refused: new Set(
      compensations.filter((entry) => entry.status === 'failed').map((entry) => entry.name),
    ),
    completedSteps: new Set(
      trail
        .filter((entry) => entry.status === 'completed')
        .filter((entry) => !entry.name.startsWith(compensationPrefix))
        .map((entry) => entry.name),
    ),
    unwindingBegan: compensations.length > 0,
  }
}

/**
 * The same body the inline executor would run, driven through a durable platform's step
 * primitives instead of straight through. The run record was opened by `startDurableWorkflow`
 * before the instance existed, so this only ever writes to it.
 */
export const executeDurable = async <
  Ctx extends WorkflowRuntime,
  Input extends StandardSchemaV1,
  Output,
>(
  definition: DurableWorkflow<Ctx, Input, Output>,
  params: { runId: string; input: unknown },
  ctx: Ctx,
  step: StepPrimitive,
): Promise<Output> => {
  const entry = await entryStateOf(ctx.journal, ctx.tenantId, params.runId)

  if (entry.closed) {
    // A run that completed answers with what it decided. Anything else already has an outcome
    // written down, and this invocation is not going to improve on it.
    if (entry.status === 'completed') return entry.output as Output

    throw new SagaError({
      runId: params.runId,
      workflowName: definition.name,
      failedStep: null,
      outcome: entry.status as CompensationOutcome,
      compensated: [],
      failedCompensations: [],
      cause: new SagaflowError(
        `run ${params.runId} was already ${entry.status} when this invocation began`,
      ),
    })
  }

  const trail = await trailAtEntry(ctx.journal, ctx.tenantId, params.runId)
  const parsed = await validate(definition.input, params.input, `the input of ${definition.name}`)

  return executeRun<Ctx, Output>({
    ...trail,
    name: definition.name,
    runId: params.runId,
    ctx,
    runner: (name, config, run) => step.do(name, config, run),
    invoke: (handle) => {
      const durable: DurableWorkflowHandle<Ctx> = {
        ...handle,
        sleep: (name, duration) => step.sleep(name, duration),
        waitForEvent: (name, options) => step.waitForEvent(name, options),
      }

      return definition.body(parsed, durable)
    },
    ...(definition.output === undefined ? {} : { output: definition.output }),
  })
}
