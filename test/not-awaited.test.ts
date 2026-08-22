import { describe, expect, it } from 'bun:test'

import { saga, sagaflow, SagaflowError, step } from 'sagaflow'
import { createMemoryJournal } from 'sagaflow/memory'

// Every verb returns a promise and every example awaits one, so a missing `await` is a typo
// rather than a style choice — and a typo that would otherwise let a run be written down as
// completed while one of its steps was still going.
describe('a step the body forgot to await', () => {
  it('fails the run and names the step', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const forgetful = saga('thing.forgetful', async () => {
      await step('first', async () => 1)
      // deliberately not awaited
      void step('second', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))

        return 2
      })

      return 'done'
    })

    const result = await forgetful.try(undefined, flow)

    expect(result.ok).toBe(false)
    expect(result.ok ? null : (result.cause as Error).message).toBe("step 'second' was not awaited")
    expect(result.ok ? null : (result.cause as Error)).toBeInstanceOf(SagaflowError)
  })

  it('undoes what the run had already done', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })
    const undone: string[] = []

    const forgetful = saga('thing.forgetful-undo', async () => {
      await step(
        'first',
        async () => 'a',
        () => {
          undone.push('first')
        },
      )
      void step('second', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
    })

    await forgetful.try(undefined, flow)

    expect(undone).toEqual(['first'])
    expect(journal.runs[0]?.status).toBe('compensated')
  })

  it('leaves a body that awaited everything alone', async () => {
    const journal = createMemoryJournal()
    const flow = sagaflow({ journal: journal.journal })

    const careful = saga('thing.careful', async () => {
      await step('first', async () => 1)
      await step('second', async () => 2)

      return 'done'
    })

    expect(await careful(undefined, flow)).toBe('done')
  })
})
