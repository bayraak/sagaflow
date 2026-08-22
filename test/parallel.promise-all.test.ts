import { describe, expect, it } from 'bun:test'

import { saga, sagaflow, step } from '@bayraak/sagaflow'
import { createMemoryJournal } from '@bayraak/sagaflow/memory'

const gate = (): { passed: Promise<void>; open: () => void } => {
  let open!: () => void
  const passed = new Promise<void>((resolve) => (open = resolve))

  return { passed, open }
}

// There is no parallel-group verb, because `Promise.all` already is one. The engine records
// start order, waits for every in-flight step before it unwinds, and refuses a body that
// returns while a step it started is still going — which is everything a group would have
// added, minus a word to learn.
describe('steps run at the same time', () => {
  it('answers with the results in order', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })

    const fan = saga('thing.fan', async (input: { mark: string }) =>
      Promise.all([
        step('a', async () => `a:${input.mark}`),
        step('b', async () => `b:${input.mark}`),
        step('c', async () => `c:${input.mark}`),
      ]),
    )

    expect(await fan({ mark: 'x' }, flow)).toEqual(['a:x', 'b:x', 'c:x'])
  })

  it('really does run them at the same time', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })
    const blocker = gate()

    const fan = saga('thing.fan-concurrent', async () =>
      Promise.all([
        step('waiting', async () => {
          await blocker.passed

          return 'waited'
        }),
        step('opening', async () => {
          blocker.open()

          return 'opened'
        }),
      ]),
    )

    expect(await fan(undefined, flow)).toEqual(['waited', 'opened'])
  })

  it('undoes the one that started last, first', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })
    const undone: string[] = []
    const blocker = gate()

    const fan = saga('thing.fan-undo', async () => {
      await Promise.all([
        step(
          'slow',
          async () => {
            await blocker.passed

            return 'slow'
          },
          () => {
            undone.push('slow')
          },
        ),
        step(
          'quick',
          async () => {
            blocker.open()

            return 'quick'
          },
          () => {
            undone.push('quick')
          },
        ),
      ])
      await step('boom', async () => {
        throw new Error('no')
      })
    })

    await fan.try(undefined, flow)

    // Reverse START order — the gated step finished last but was asked for first.
    expect(undone).toEqual(['quick', 'slow'])
  })

  it('lets everything stop before it reports the failure', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })
    const finished: string[] = []
    const blocker = gate()

    const fan = saga('thing.fan-failure', async () =>
      Promise.all([
        step('slow', async () => {
          await blocker.passed
          finished.push('slow')
        }),
        step('fast', async () => {
          blocker.open()
          finished.push('fast')

          throw new Error('fast refused')
        }),
      ]),
    )

    const result = await fan.try(undefined, flow)

    expect(result.ok).toBe(false)
    expect(finished).toEqual(['fast', 'slow'])
  })

  // Racing belongs inside a step, where the platform memoises the winner. A race at the body
  // level would be non-deterministic across a replay, which is the one thing a durable body
  // must not be.
  it('races inside a step, where the answer is memoised', async () => {
    const flow = sagaflow({ journal: createMemoryJournal().journal })

    const fastest = saga('thing.race', async () =>
      step('winner', () =>
        Promise.race([
          new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 20)),
          Promise.resolve('quick'),
        ]),
      ),
    )

    expect(await fastest(undefined, flow)).toBe('quick')
  })
})
