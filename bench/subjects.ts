import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { saga, sagaflow, step } from 'sagaflow-js'
import { createMemoryJournal } from 'sagaflow-js/memory'
import { createSqliteJournal } from 'sagaflow-js/sqlite'

/*
 * What is being measured, and what is deliberately not.
 *
 * Measured: everything sagaflow does around a step — the ambient scope, the run record, the
 * per-step write, the compensation registered from the return value, the envelope minted for
 * the run's own completion, and the one atomic write that closes it.
 *
 * Not measured: the work itself, which is yours; and delivery, which is your queue's. No sink
 * is configured, so no drain happens. A number that included an in-process sink would be
 * measuring an array push, and a number that included a real queue would be measuring the
 * queue.
 */

export const stepCounts = [1, 5, 20] as const

/** Named once, up front, so no benchmark measures string concatenation. */
const names = Array.from({ length: 20 }, (_unused, index) => `step-${index}`)

/** The least a step can do, so the measurement is the engine around the work. */
const work = async (index: number): Promise<{ index: number }> => ({ index })

/** The same calls, awaited, with nothing at all around them. The floor. */
export const plainRun = async (steps: number): Promise<void> => {
  for (let index = 0; index < steps; index += 1) await work(index)
}

type BenchSaga = ReturnType<typeof sagaOf>

function sagaOf(steps: number) {
  return saga(`bench.${steps}-steps`, async (input: { seat: string }) => {
    for (let index = 0; index < steps; index += 1) {
      await step(
        names[index] ?? `step-${index}`,
        () => work(index),
        // Declared and never run. Registering it is part of what a step costs.
        () => undefined,
      )
    }

    return input.seat
  })
}

export type Subject = {
  /** Fresh state for the next sample. Called outside the measured region. */
  reset(): void
  run(steps: number): Promise<unknown>
}

export const memorySubject = (): Subject => {
  const memory = createMemoryJournal()
  const flow = sagaflow({ journal: memory.journal })
  const sagas = new Map<number, BenchSaga>(stepCounts.map((steps) => [steps, sagaOf(steps)]))

  return {
    reset: () => {
      // Emptied rather than rebuilt: the journal reads its own arrays on every write, so a
      // benchmark that let them grow would be measuring the fixture rather than the engine.
      memory.runs.length = 0
      memory.steps.length = 0
      memory.finishes.length = 0
      memory.outbox.length = 0
      memory.dispatched.length = 0
    },
    run: (steps) => sagas.get(steps)?.({ seat: '12A' }, flow) ?? Promise.resolve(),
  }
}

export const sqliteSubject = (): Subject => {
  const database = new Database(':memory:')
  database.exec(readFileSync(path.join(import.meta.dirname, '../src/sql/schema.sql'), 'utf8'))

  const flow = sagaflow({ journal: createSqliteJournal(database) })
  const sagas = new Map<number, BenchSaga>(stepCounts.map((steps) => [steps, sagaOf(steps)]))
  const clear = database.transaction(() => {
    database.run('delete from saga_run_steps')
    database.run('delete from saga_outbox')
    database.run('delete from saga_runs')
  })

  return {
    reset: () => clear(),
    run: (steps) => sagas.get(steps)?.({ seat: '12A' }, flow) ?? Promise.resolve(),
  }
}
