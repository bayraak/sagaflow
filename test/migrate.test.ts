import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { schemaSql, schemaStatements } from '@bayraak/sagaflow/sql'
import { createSqliteJournal } from '@bayraak/sagaflow/sqlite'
import { journalConformance } from '@bayraak/sagaflow/testing'

// Getting started should not require finding a DDL file, deciding where to put it and wiring a
// migration tool. `migrate()` is the two-minute path; your migration tool is the grown-up one,
// and the SQL it needs is the same SQL.
describe('a journal that can set itself up', () => {
  it('creates everything the contract needs', async () => {
    const db = new Database(':memory:')
    const journal = createSqliteJournal(db)

    await journal.migrate()

    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all() as { name: string }[]

    expect(tables.map((row) => row.name)).toEqual(['saga_outbox', 'saga_run_steps', 'saga_runs'])
  })

  it('is safe to run twice', async () => {
    const db = new Database(':memory:')
    const journal = createSqliteJournal(db)

    await journal.migrate()
    await journal.migrate()

    const runId = await journal.insertRun({
      tenantId: 'acme',
      name: 'thing.save',
      execution: 'inline',
      idempotencyKey: null,
      input: {},
    })

    expect(typeof runId).toBe('string')
  })

  it('honours the table names it was given', async () => {
    const db = new Database(':memory:')
    const journal = createSqliteJournal(db, {
      tables: { runs: 'flow_runs', steps: 'flow_steps', outbox: 'flow_outbox' },
    })

    await journal.migrate()

    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all() as { name: string }[]

    expect(tables.map((row) => row.name)).toEqual(['flow_outbox', 'flow_runs', 'flow_steps'])
  })

  // What it creates has to be the thing the contract is proved against, or the two-minute path
  // is a two-minute path to a journal that does not work.
  it('creates a journal that answers the whole contract', async () => {
    const cases = journalConformance(async () => {
      const db = new Database(':memory:')
      const journal = createSqliteJournal(db)
      await journal.migrate()

      return {
        journal,
        runStatus: async ({ tenantId, runId }) => {
          const row = db
            .prepare('select status from saga_runs where tenant_id = ? and id = ?')
            .get(tenantId, runId) as { status: string } | null

          return (row?.status as never) ?? null
        },
        countSteps: async ({ runId }) =>
          (
            db
              .prepare('select count(*) as total from saga_run_steps where run_id = ?')
              .get(runId) as {
              total: number
            }
          ).total,
        breakOutboxWrites: () => {
          db.exec('drop table saga_outbox')
        },
      }
    })

    for (const conformanceCase of cases) await conformanceCase.run()

    expect(cases.length).toBeGreaterThan(30)
  })
})

// The file a migration tool reads and the statements `migrate()` runs must be the same schema.
// They are, because one is written from the other — and this is what proves it stayed that way.
describe('the shipped DDL and the statements are one schema', () => {
  it('has not drifted', () => {
    const onDisk = readFileSync(path.join(import.meta.dirname, '../src/sql/schema.sql'), 'utf8')

    expect(onDisk.trimEnd()).toBe(schemaSql.trimEnd())
    expect(schemaStatements.length).toBeGreaterThan(5)
  })
})
