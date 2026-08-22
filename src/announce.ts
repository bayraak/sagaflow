import { emit } from './ambient.js'

/** What an effect says it announced: one event, several, or none. */
export type Announcement = [type: string, payload: unknown]

export type Announce<Result, Input> = (
  result: Result,
  input: Input,
) => Announcement | Announcement[] | null | undefined

const isOne = (announced: Announcement | Announcement[]): announced is Announcement =>
  typeof announced[0] === 'string'

/**
 * Announce what an effect did, from inside the step that did it.
 *
 * Emitting here rather than after the step is what gives it every property the body's own `emit`
 * has and one more: the announcement is part of the step's memoised result, so a replayed step
 * announces exactly once, and a run that is undone announces none of it.
 */
export const announceResult = async <Result, Input>(
  announce: Announce<Result, Input> | undefined,
  result: Result,
  input: Input,
): Promise<void> => {
  const announced = announce?.(result, input)
  if (!announced) return

  for (const [type, payload] of isOne(announced) ? [announced] : announced) {
    await emit(type, payload)
  }
}
