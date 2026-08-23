import { describe, expect, it } from 'bun:test'

import { saga, sagaflow } from 'sagaflow-js'

/*
 * What somebody sees in the first five minutes.
 *
 * The zero-configuration path exists so a saga runs before anything is configured, and every
 * line it prints is spent from a budget of about two: past that, a reader stops reading, and the
 * one line that mattered — this is not durable — is lost inside the ones that did not.
 *
 * Two things used to go wrong. The warning was said twice, by two different pieces of code that
 * had each decided it was theirs to say, in two different wordings. And the in-process sink
 * pretty-printed every envelope under the run's own trail line, including the lifecycle event
 * the engine had just minted, so a two-step run printed four times.
 */
const notDurable =
  'sagaflow: in-memory journal — state is lost when the process exits; ' +
  'pass a journal (sagaflow-js/sqlite or sagaflow-js/d1) before production.'

const write = saga('thing.write', async (input: { mark: string }, s) => {
  await s.step('reserve', async () => ({ id: input.mark }))
  await s.step('charge', async () => ({ paid: true }))
  await s.emit('booking.created', { id: input.mark })
})

const captureConsole = async (body: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = []
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
  }
  const original = { info: console.info, warn: console.warn, log: console.log }

  console.info = record
  console.warn = record
  console.log = record
  try {
    await body()
  } finally {
    console.info = original.info
    console.warn = original.warn
    console.log = original.log
  }

  return lines
}

describe('the warning the zero-configuration path owes you', () => {
  it('is one line, in the words that say what to do about it', async () => {
    const warnings: string[] = []
    const flow = sagaflow({ warn: (message) => warnings.push(message) })

    await write({ mark: 'a' }, flow)

    expect(warnings).toEqual([notDurable])
  })

  it('is said once per instance, however many runs go through it', async () => {
    const warnings: string[] = []
    const flow = sagaflow({ warn: (message) => warnings.push(message) })

    await write({ mark: 'a' }, flow)
    await write({ mark: 'b' }, flow)
    await write({ mark: 'c' }, flow)

    expect(warnings).toHaveLength(1)
  })

  it('is not said at all once there is a journal to be durable in', async () => {
    const warnings: string[] = []
    const { createMemoryJournal } = await import('../src/memory/index')
    const flow = sagaflow({
      journal: createMemoryJournal().journal,
      warn: (message) => warnings.push(message),
    })

    await write({ mark: 'a' }, flow)

    expect(warnings).toEqual([])
  })

  it('is the only thing an explicit empty configuration prints', async () => {
    const lines = await captureConsole(async () => {
      const flow = sagaflow({})
      await write({ mark: 'a' }, flow)
    })

    expect(lines.filter((line) => line.includes('in-memory journal'))).toHaveLength(1)
    expect(lines.filter((line) => line.includes('using the in-memory default'))).toEqual([])
  })
})

describe('what the development logger prints for a run', () => {
  it('says what the run emitted on the run’s own line, and nowhere else', async () => {
    const lines = await captureConsole(async () => {
      const flow = sagaflow({ warn: () => undefined })
      await write({ mark: 'a' }, flow)
    })

    const trail = lines.filter((line) => line.includes('thing.write'))
    expect(trail).toHaveLength(1)
    expect(trail[0]).toContain('reserve ✓ charge ✓')
    expect(trail[0]).toContain('2 events (booking.created, workflow.completed)')
  })

  it('never prints an event object of its own accord', async () => {
    const lines = await captureConsole(async () => {
      const flow = sagaflow({ warn: () => undefined })
      await write({ mark: 'a' }, flow)
    })

    expect(lines.filter((line) => line.includes('{'))).toEqual([])
    expect(
      lines.filter((line) => line.includes('workflow.completed') && line.includes('runId')),
    ).toEqual([])
  })

  it('names the closure of a run that did not get there', async () => {
    const failing = saga('thing.refuse', async (_input: { mark: string }, s) => {
      await s.step('reserve', async () => ({ id: 1 }))
      await s.step('charge', async () => {
        throw new Error('the card was declined')
      })
    })

    const lines = await captureConsole(async () => {
      const flow = sagaflow({ warn: () => undefined })
      await failing({ mark: 'a' }, flow).catch(() => undefined)
    })

    const trail = lines.filter((line) => line.includes('thing.refuse'))
    expect(trail).toHaveLength(1)
    expect(trail[0]).toContain('1 event (workflow.compensated)')
  })
})
