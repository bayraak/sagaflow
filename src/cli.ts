import { defaultTableNames, schemaFor, schemaSql } from './sql/schema.js'

const usage = `sagaflow — an embedded saga engine

  sagaflow schema [options]     print the DDL for the three tables

Options
  --dialect sqlite|d1           which database (default: sqlite; D1 is SQLite)
  --format sql                  what to print (default: sql)
  --tables runs=a,steps=b,outbox=c
                                rename the tables, matching createSqlJournal's \`tables\`

Examples
  bunx sagaflow schema > migrations/0001_sagaflow.sql
  bunx sagaflow schema --tables runs=flow_runs,steps=flow_steps,outbox=flow_outbox
`

const dialects = new Set(['d1', 'sqlite'])
const formats = new Set(['sql'])

const flagOf = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)

  return at === -1 ? undefined : argv[at + 1]
}

const tablesFrom = (given: string | undefined): { runs: string; steps: string; outbox: string } => {
  if (given === undefined) return defaultTableNames

  const named = Object.fromEntries(
    given.split(',').map((pair) => pair.split('=').map((part) => part.trim())),
  ) as Partial<typeof defaultTableNames>

  return { ...defaultTableNames, ...named }
}

/**
 * The whole command, as a function, so it can be tested without spawning anything and without a
 * dependency on an argument parser. Answers with what it would print and the code it would exit
 * with, and prints nothing itself.
 */
export const runCli = (argv: string[]): { output: string; code: number } => {
  const [command] = argv

  if (command === undefined) return { output: usage, code: 1 }
  if (command === '--help' || command === '-h' || command === 'help') {
    return { output: usage, code: 0 }
  }

  if (command !== 'schema') {
    return { output: `sagaflow has no "${command}" command.\n\n${usage}`, code: 1 }
  }

  const dialect = flagOf(argv, 'dialect') ?? 'sqlite'
  const format = flagOf(argv, 'format') ?? 'sql'

  if (!dialects.has(dialect)) {
    return {
      output: `sagaflow has no schema for "${dialect}" — it has ${[...dialects].join(' and ')}. D1 is SQLite, so the two are the same DDL.`,
      code: 1,
    }
  }

  if (!formats.has(format)) {
    return {
      output: `sagaflow cannot print "${format}" — it prints ${[...formats].join(' and ')}.`,
      code: 1,
    }
  }

  const tables = tablesFrom(flagOf(argv, 'tables'))
  const renamed =
    tables.runs === defaultTableNames.runs &&
    tables.steps === defaultTableNames.steps &&
    tables.outbox === defaultTableNames.outbox

  return { output: renamed ? schemaSql : `${schemaFor(tables).join(';\n\n')};\n`, code: 0 }
}
