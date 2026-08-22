export type SqlStatement = { sql: string; params: unknown[] }

/**
 * The three things the engine needs from a database, and nothing else. Every ORM and every
 * driver exposes these underneath, which is why sagaflow does not need to know which one you
 * use — a driver is a dozen lines mapping your executor onto this.
 */
export type SqlDriver = {
  run: (statement: SqlStatement) => Promise<{ changes: number }>
  all: <Row>(statement: SqlStatement) => Promise<Row[]>
  /**
   * ATOMIC. All of the statements or none of them, and the rows each one answered, in order.
   * This is the load-bearing one: the finish that closes a run and queues its events is a
   * batch, and if a driver's batch is not atomic then "completed with its audit trail lost"
   * becomes representable again. On D1 this is `db.batch`; elsewhere it is a transaction.
   */
  batch: (statements: SqlStatement[]) => Promise<unknown[][]>
}
