import { describe, expect, it } from 'bun:test'

import { saga, sagaflow, sizeGuard, step, stepOutputLimit } from '@bayraak/sagaflow'
import { createMemoryJournal } from '@bayraak/sagaflow/memory'

const big = (bytes: number): string => 'x'.repeat(bytes)

// Cloudflare refuses a step output over a mebibyte, at runtime, in production, on the run that
// finally had a big enough import to trip it. A warning in development is cheaper than that
// discovery, and costs nothing when nobody is listening.
describe('a step that returns too much', () => {
  it('is warned about, by name and with a size', async () => {
    const warnings: string[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({
      journal: journal.journal,
      observer: sizeGuard({ warn: (message) => warnings.push(message) }),
    })

    const fat = saga('thing.fat', async () => step('load-everything', async () => big(1_200_000)))

    await fat(undefined, flow)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('load-everything')
    expect(warnings[0]).toContain('1 MiB')
  })

  it('says nothing about a step that returns a receipt', async () => {
    const warnings: string[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({
      journal: journal.journal,
      observer: sizeGuard({ warn: (message) => warnings.push(message) }),
    })

    const lean = saga('thing.lean', async () => step('load', async () => ({ rows: 40_000 })))

    await lean(undefined, flow)

    expect(warnings).toEqual([])
  })

  it('takes a limit of its own, for a platform with a different one', async () => {
    const warnings: string[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({
      journal: journal.journal,
      observer: sizeGuard({ limit: 100, warn: (message) => warnings.push(message) }),
    })

    const fat = saga('thing.small-limit', async () => step('load', async () => big(200)))

    await fat(undefined, flow)

    expect(warnings).toHaveLength(1)
    expect(stepOutputLimit).toBe(1_048_576)
  })

  // Measuring every step's output costs a serialisation per step. Nobody pays it unless somebody
  // has asked to be told.
  it('is not measured at all when nobody is watching for it', async () => {
    const measured: unknown[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({
      journal: journal.journal,
      observer: { onStepEnd: (fact) => measured.push(fact.name) },
    })

    const fat = saga('thing.unmeasured', async () => step('load', async () => big(1_200_000)))

    await fat(undefined, flow)

    expect(measured).toEqual(['load'])
  })

  it('never fails the run over it', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({
      journal: journal.journal,
      observer: sizeGuard({
        warn: () => {
          throw new Error('the logger is on fire')
        },
      }),
    })

    const fat = saga('thing.hostile-warn', async () => step('load', async () => big(1_200_000)))

    expect((await fat(undefined, flow)).length).toBe(1_200_000)
    expect(journal.runs[0]?.status).toBe('completed')
  })

  it('says nothing about an output it cannot measure', async () => {
    const warnings: string[] = []
    const journal = createMemoryJournal()
    const flow = sagaflow({
      journal: journal.journal,
      observer: sizeGuard({ warn: (message) => warnings.push(message) }),
    })

    const circular = saga('thing.circular', async () =>
      step('load', async () => {
        const value: Record<string, unknown> = {}
        value.self = value

        return value
      }),
    )

    await circular(undefined, flow)

    expect(warnings).toEqual([])
  })
})
