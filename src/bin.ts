#!/usr/bin/env node
import { runCli } from './cli.js'

/*
 * The executable. Separate from the command itself so that importing `runCli` — in a test, or in
 * a script that wants the DDL as a string — does not exit the process that imported it.
 */
const answered = runCli(process.argv.slice(2))

process.stdout.write(answered.output.endsWith('\n') ? answered.output : `${answered.output}\n`)
process.exit(answered.code)
