import { describe, it } from 'bun:test'

import { createMemoryJournal } from 'sagaflow/memory'
import { journalConformance } from 'sagaflow/testing'

// The memory journal is a real subject of the contract, not a convenience that gets a pass.
// Every rule the D1 and SQLite adapters have to keep, it keeps.
describe('the memory journal honours the RunJournal contract', () => {
  const cases = journalConformance(() => {
    const memory = createMemoryJournal()

    return {
      journal: memory.journal,
      runStatus: async ({ tenantId, runId }) =>
        memory.runs.find((run) => run.tenantId === tenantId && run.id === runId)?.status ?? null,
      countSteps: async ({ runId }) => memory.steps.filter((step) => step.runId === runId).length,
      breakOutboxWrites: memory.breakOutboxWrites,
    }
  })

  for (const conformanceCase of cases) it(conformanceCase.name, conformanceCase.run)
})
