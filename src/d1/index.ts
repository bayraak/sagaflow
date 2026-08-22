/// <reference types="@cloudflare/workers-types" />

import {
  createSqlJournal,
  type SqlDriver,
  type SqlJournal,
  type SqlTableNames,
} from '../sql/index.js'

/**
 * D1, made to look like the driver the journal wants.
 *
 * `db.batch` is the only atomic unit D1 has — `db.transaction()` does not exist on it, and the
 * ORMs that expose one against D1 throw at runtime. That is why the journal contract asks for a
 * batch rather than a transaction: the shape it needs is the shape this platform actually has.
 */
export const createD1Driver = (db: D1Database): SqlDriver => {
  const prepare = ({ sql, params }: { sql: string; params: unknown[] }): D1PreparedStatement =>
    params.length === 0 ? db.prepare(sql) : db.prepare(sql).bind(...params)

  return {
    run: async (statement) => {
      const answered = await prepare(statement).run()

      return { changes: answered.meta.changes }
    },
    all: async <Row>(statement: { sql: string; params: unknown[] }) => {
      const answered = await prepare(statement).all<Row>()

      return answered.results
    },
    batch: async (statements) => {
      const answered = await db.batch(statements.map((statement) => prepare(statement)))

      return answered.map((result) => result.results as unknown[])
    },
  }
}

export const createD1Journal = (
  db: D1Database,
  options: { tables?: Partial<SqlTableNames>; now?: () => number } = {},
): SqlJournal => createSqlJournal(createD1Driver(db), options)
