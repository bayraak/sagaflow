import { createSqlJournal, type SqlDriver, type SqlTableNames } from '../sql/index.js'
import type { RunJournal } from '../types.js'

/**
 * Structurally `bun:sqlite`'s Database and `node:sqlite`'s DatabaseSync, narrowed to what a
 * journal does. Declared rather than imported so this file needs neither runtime and works on
 * both — and on better-sqlite3, which has the same shape.
 */
export type SqliteDatabase = {
  // Methods rather than function properties on purpose: TypeScript checks method parameters
  // bivariantly, which is what lets a real driver with its own narrower binding types satisfy
  // this without every caller having to cast.
  prepare(sql: string): {
    all(...params: never[]): unknown[]
    run(...params: never[]): { changes: bigint | number }
  }
}

/**
 * A synchronous SQLite database, made to look like the driver the journal wants.
 *
 * `batch` is a real transaction. SQLite gives us the atomicity D1 gives us through its own
 * batch, and the finish depends on having it: either the run closed and its events are queued,
 * or neither happened.
 */
export const createSqliteDriver = (db: SqliteDatabase): SqlDriver => {
  const execute = (sql: string): { changes: bigint | number } => db.prepare(sql).run()

  return {
    run: async ({ sql, params }) => {
      const answered = db.prepare(sql).run(...(params as never[]))

      return { changes: Number(answered.changes) }
    },
    all: async <Row>({ sql, params }: { sql: string; params: unknown[] }) =>
      db.prepare(sql).all(...(params as never[])) as Row[],
    batch: async (statements) => {
      execute('begin')

      try {
        const answers: unknown[][] = []
        for (const statement of statements) {
          answers.push(db.prepare(statement.sql).all(...(statement.params as never[])))
        }

        execute('commit')

        return answers
      } catch (error) {
        execute('rollback')

        throw error
      }
    },
  }
}

export const createSqliteJournal = (
  db: SqliteDatabase,
  options: { tables?: Partial<SqlTableNames>; now?: () => number } = {},
): RunJournal => createSqlJournal(createSqliteDriver(db), options)
