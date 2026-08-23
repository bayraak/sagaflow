import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createMemoryJournal } from 'sagaflow-js/memory'
import { journalConformance } from 'sagaflow-js/testing'

const words = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
]

const spelled = (count: number): string => {
  if (count <= 20) return words[count] as string

  const tens = [
    '',
    '',
    'twenty',
    'thirty',
    'forty',
    'fifty',
    'sixty',
    'seventy',
    'eighty',
    'ninety',
  ]
  const ten = tens[Math.floor(count / 10)] as string
  const unit = count % 10

  return unit === 0 ? ten : `${ten}-${words[unit] as string}`
}

// This number has drifted three ways already — 34 in one document, thirty-five in two others,
// thirty-seven in the code. A count in prose is a fact that goes stale in silence, so the one
// place it is still written down is checked against the suite itself.
describe('the documented size of the conformance suite', () => {
  const cases = journalConformance(() => {
    const memory = createMemoryJournal()

    return {
      journal: memory.journal,
      runStatus: async () => null,
      countSteps: async () => 0,
      breakOutboxWrites: memory.breakOutboxWrites,
    }
  })

  it('is what the suite actually contains', () => {
    const adapters = readFileSync(path.join(import.meta.dirname, '../docs/adapters.md'), 'utf8')
    const capitalised = spelled(cases.length).replace(/^./, (letter) => letter.toUpperCase())

    expect(adapters).toContain(`${capitalised} cases covering`)
  })

  it('is not repeated anywhere it would go stale unnoticed', () => {
    for (const document of ['../README.md', '../SKILL.md', '../docs/cheatsheet.md']) {
      const text = readFileSync(path.join(import.meta.dirname, document), 'utf8')

      expect(text).not.toMatch(/(thirty|forty)-\w+ (executable )?cases/)
      expect(text).not.toMatch(/\b\d{2} cases\b/)
    }
  })

  it('gives every case a name of its own', () => {
    const names = cases.map((one) => one.name)

    expect(new Set(names).size).toBe(names.length)
  })
})
