import { Database } from 'bun:sqlite'
import { describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createSqliteJournal } from 'sagaflow/sqlite'
import { journalConformance } from 'sagaflow/testing'

const ddl = readFileSync(path.join(import.meta.dirname, '../src/sql/schema.sql'), 'utf8')

// The same 34 cases, against a real database with real constraints. Everything the contract
// asks for — the partial unique index that releases a key, the conflict clauses that make a
// repeat write nothing, the batch that makes a finish one write — is enforced by SQLite here
// rather than by an array in memory.
describe('the SQLite journal honours the RunJournal contract', () => {
  const cases = journalConformance(() => {
    const db = new Database(':memory:')
    db.exec(ddl)

    return {
      journal: createSqliteJournal(db),
      runStatus: async ({ tenantId, runId }) => {
        const row = db
          .prepare('select status from saga_runs where tenant_id = ? and id = ?')
          .get(tenantId, runId) as { status: string } | null

        return (row?.status as never) ?? null
      },
      countSteps: async ({ runId }) => {
        const row = db
          .prepare('select count(*) as total from saga_run_steps where run_id = ?')
          .get(runId) as { total: number }

        return row.total
      },
      breakOutboxWrites: () => {
        db.exec('drop table saga_outbox')
      },
    }
  })

  for (const conformanceCase of cases) it(conformanceCase.name, conformanceCase.run)
})
