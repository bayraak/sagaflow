import { describe, expect, it } from 'bun:test'

import { explainRun, saga, sagaflow, step } from 'sagaflow-js'
import { createMemoryJournal } from 'sagaflow-js/memory'
import { trailOf } from 'sagaflow-js/testing'

const bookedRun = async (): Promise<{
  journal: ReturnType<typeof createMemoryJournal>
  flow: ReturnType<typeof sagaflow>
  runId: string
}> => {
  const journal = createMemoryJournal()
  const flow = sagaflow({ journal: journal.journal })

  const book = saga('booking.explain', async (input: { seat: string }) => {
    await step(
      'reserve',
      async () => ({ id: `hold_${input.seat}` }),
      () => undefined,
    )
    await step('boom', async () => {
      throw new Error('the card was declined')
    })
  })

  await book.try({ seat: '12A' }, flow)

  return { journal, flow, runId: journal.runs[0]?.id as string }
}

// A run record is rows, which is right for a database and wrong for a person at three in the
// morning. This is the same rows, arranged so somebody can read them.
describe('explaining a run', () => {
  it('reads as a trail, with what failed and what was undone', async () => {
    const { journal, runId } = await bookedRun()

    const explained = await explainRun({
      journal: journal.journal,
      tenantId: 'default',
      runId,
    })

    expect(explained).toContain('booking.explain')
    expect(explained).toContain(runId)
    expect(explained).toContain('compensated')
    expect(explained).toContain('reserve')
    expect(explained).toContain('boom')
    expect(explained).toContain('the card was declined')
    expect(explained).toContain('compensate:reserve')
  })

  it('draws the same run as mermaid when asked', async () => {
    const { journal, runId } = await bookedRun()

    const drawn = await explainRun({
      journal: journal.journal,
      tenantId: 'default',
      runId,
      format: 'mermaid',
    })

    expect(drawn.startsWith('```mermaid')).toBe(true)
    expect(drawn).toContain('flowchart')
    expect(drawn).toContain('reserve')
    expect(drawn).toContain('compensate:reserve')
    expect(drawn.trimEnd().endsWith('```')).toBe(true)
  })

  it('says so plainly when there is no such run', async () => {
    const journal = createMemoryJournal()

    expect(
      await explainRun({ journal: journal.journal, tenantId: 'default', runId: 'run_nowhere' }),
    ).toContain('no run')
  })

  it('is on the instance too, for the run you are already holding', async () => {
    const { flow, runId } = await bookedRun()

    expect(await flow.explain(runId)).toContain('booking.explain')
    expect(await flow.explain(runId, { format: 'mermaid' })).toContain('flowchart')
  })
})

// The one-line assertion every saga test wants, so nobody writes the same map twice.
describe('the trail of a run, for a test', () => {
  it('is name and status, in order', async () => {
    const { journal, runId } = await bookedRun()

    expect(await trailOf({ journal: journal.journal, runId })).toEqual([
      'reserve:completed',
      'boom:failed',
      'compensate:reserve:compensated',
    ])
  })

  it('is empty for a run nobody has heard of', async () => {
    const journal = createMemoryJournal()

    expect(await trailOf({ journal: journal.journal, runId: 'run_nowhere' })).toEqual([])
  })
})
