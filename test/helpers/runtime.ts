import type { WorkflowRuntime } from '../../src/index'
import { createMemoryJournal, createMemorySink } from '../../src/memory/index'

// Everything a suite needs to watch a run: the seams the engine writes through, plus a log
// of what the step bodies actually did. The invocation log is the only way to tell "the step
// ran and was undone" apart from "the step never ran", and that distinction is most of what
// a saga has to get right.
export type TestRuntime = WorkflowRuntime & { invocations: string[] }

export const createTestRuntime = (options: { sinkRefuses?: boolean } = {}) => {
  const journal = createMemoryJournal()
  const sink = createMemorySink({ refuses: options.sinkRefuses })
  const invocations: string[] = []

  const ctx: TestRuntime = {
    tenantId: 'tenant_local',
    actor: 'tester',
    journal: journal.journal,
    events: sink.sink,
    invocations,
  }

  return { ctx, invocations, ...journal, ...sink }
}

export const firstRun = (runs: ReturnType<typeof createMemoryJournal>['runs']) => {
  const run = runs[0]
  if (!run) throw new Error('no run was opened')

  return run
}

export const firstFinish = (finishes: ReturnType<typeof createMemoryJournal>['finishes']) => {
  const finish = finishes[0]
  if (!finish) throw new Error('the run never finished')

  return finish
}
