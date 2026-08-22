import ddl from '../src/sql/schema.sql?raw'

// The reference DDL is the single source of truth, so the suite applies exactly the file a user
// would copy into their migration — not a second copy that could quietly drift from it.
const statementsOf = (sql: string): string[] =>
  sql
    .replaceAll(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

/** Tables the test worker owns, beside the three sagaflow owns. */
const fixtures = [
  'create table if not exists things (id text primary key, tenant_id text not null, mark text not null)',
  'create table if not exists delivered (id text primary key, type text not null)',
]

export const applySchema = async (db: D1Database): Promise<void> => {
  for (const statement of [...statementsOf(ddl), ...fixtures]) {
    await db.prepare(statement).run()
  }
}

export const truncate = async (db: D1Database): Promise<void> => {
  for (const table of ['saga_outbox', 'saga_run_steps', 'saga_runs', 'things', 'delivered']) {
    await db.prepare(`delete from ${table}`).run()
  }
}
