import { writeFileSync } from 'node:fs'
import path from 'node:path'

import { schemaSql } from '../src/sql/schema.js'

// One schema, written down twice: once as a module `migrate()` can run in a Worker, and once as
// a file a migration tool can read. This writes the second from the first, and
// test/migrate.test.ts fails if anybody edits the file instead.
const target = path.join(import.meta.dirname, '../src/sql/schema.sql')
writeFileSync(target, schemaSql)

console.info(`wrote ${path.relative(process.cwd(), target)}`)
