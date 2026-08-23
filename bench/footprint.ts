import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * The one number in this benchmark that is the same on every machine: how much you have to
 * write to get the same six guarantees three different ways. It is counted rather than
 * asserted, from files that are type-checked, so it cannot drift into a favourable estimate.
 */

export type Footprint = { subject: string; file: string; lines: number; code: number }

const commentStarts = ['//', '/*', '*/', '*']

const isCode = (line: string): boolean => {
  const trimmed = line.trim()

  return trimmed !== '' && !commentStarts.some((start) => trimmed.startsWith(start))
}

const subjects = [
  { subject: 'sagaflow', file: 'sagaflow.ts' },
  { subject: 'hand-rolled try/catch', file: 'hand-rolled.ts' },
  { subject: 'raw Cloudflare Workflows', file: 'cloudflare-workflows.ts' },
]

export const footprints = (): Footprint[] =>
  subjects.map(({ subject, file }) => {
    const source = readFileSync(path.join(import.meta.dirname, 'what-you-must-write', file), 'utf8')
    const lines = source.split('\n')
    // A trailing newline is not a line of anything.
    const written = lines.at(-1) === '' ? lines.slice(0, -1) : lines

    return {
      subject,
      file: `bench/what-you-must-write/${file}`,
      lines: written.length,
      code: written.filter(isCode).length,
    }
  })
