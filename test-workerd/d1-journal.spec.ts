import { env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, it } from 'vitest'

import { createD1Journal } from '../src/d1/index.js'
import { journalConformance } from '../src/testing/index.js'
import type { TestEnv } from './definitions.js'
import { applySchema, truncate } from './schema.js'

const bindings = env as unknown as TestEnv

// The same 34 cases the memory and SQLite journals answer, against real workerd and real local
// D1 — where the partial unique index, the conflict clauses and the atomicity of `db.batch` are
// the platform's behaviour rather than this package's opinion of it.
describe('the D1 journal honours the RunJournal contract', () => {
  beforeAll(async () => {
    await applySchema(bindings.DB)
  })

  beforeEach(async () => {
    await truncate(bindings.DB)
  })

  const cases = journalConformance(() => ({
    journal: createD1Journal(bindings.DB),
    runStatus: async ({ tenantId, runId }) => {
      const row = await bindings.DB.prepare(
        'select status from saga_runs where tenant_id = ? and id = ?',
      )
        .bind(tenantId, runId)
        .first<{ status: string }>()

      return (row?.status as never) ?? null
    },
    countSteps: async ({ runId }) => {
      const row = await bindings.DB.prepare(
        'select count(*) as total from saga_run_steps where run_id = ?',
      )
        .bind(runId)
        .first<{ total: number }>()

      return row?.total ?? 0
    },
    breakOutboxWrites: async () => {
      await bindings.DB.prepare('drop table saga_outbox').run()
    },
  }))

  for (const conformanceCase of cases) it(conformanceCase.name, conformanceCase.run)
})
