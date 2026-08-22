import { describe, expect, it } from 'bun:test'
import path from 'node:path'

import { runCli } from '../src/cli.js'

const binPath = path.join(import.meta.dirname, '../src/bin.ts')

// Zero dependencies means no commander, no yargs, and no reason for a schema to be hard to get
// hold of. `bunx sagaflow schema` prints it; that is the whole command.
describe('the schema command', () => {
  it('prints the DDL', () => {
    const { output, code } = runCli(['schema'])

    expect(code).toBe(0)
    expect(output).toContain('create table if not exists saga_runs')
    expect(output).toContain('saga_runs_held_key')
    expect(output).toContain('create table if not exists saga_outbox')
  })

  it('prints the same DDL for either dialect, and says why', () => {
    const sqlite = runCli(['schema', '--dialect', 'sqlite'])
    const d1 = runCli(['schema', '--dialect', 'd1'])

    expect(sqlite.output).toBe(d1.output)
    expect(sqlite.code).toBe(0)
  })

  it('renames the tables when asked', () => {
    const { output } = runCli([
      'schema',
      '--tables',
      'runs=flow_runs,steps=flow_steps,outbox=flow_outbox',
    ])

    expect(output).toContain('create table if not exists flow_runs')
    expect(output).not.toContain('saga_runs')
  })

  it('refuses a dialect it does not have', () => {
    const { output, code } = runCli(['schema', '--dialect', 'postgres'])

    expect(code).toBe(1)
    expect(output).toContain('postgres')
  })

  it('refuses a format it does not have', () => {
    const { code, output } = runCli(['schema', '--format', 'drizzle'])

    expect(code).toBe(1)
    expect(output).toContain('drizzle')
  })

  it('has help, and says what it is for when given nothing', () => {
    expect(runCli(['--help']).output).toContain('sagaflow schema')
    expect(runCli([]).code).toBe(1)
    expect(runCli(['migrate']).output).toContain('migrate')
  })
})

describe('the command as somebody actually runs it', () => {
  it('writes the DDL to stdout and exits zero', async () => {
    const process = Bun.spawn(['bun', binPath, 'schema'], { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(process.stdout).text()

    expect(await process.exited).toBe(0)
    expect(output).toContain('create table if not exists saga_runs')
  })
})
