import { activeObserver } from './ambient.js'

const maximumArgumentLength = 80

const describe = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null || value === undefined || typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`

  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{…}'
  }
}

/** A short, safe rendering of what a call was given. Never the arguments themselves. */
export const summarise = (args: unknown[]): string => {
  const rendered = args.map((value) => describe(value)).join(', ')

  return rendered.length > maximumArgumentLength
    ? `${rendered.slice(0, maximumArgumentLength)}…`
    : rendered
}

/**
 * Report a call that is not an effect.
 *
 * Nothing here reaches the journal: the journal is the effects a run had, which is what keeps it
 * short enough to read. The call tree belongs in a trace, and an observer that throws must not be
 * able to fail somebody's mutation, so nothing here is allowed to.
 */
export const traced = async <Result>(
  name: string,
  args: unknown[],
  work: () => Promise<Result>,
): Promise<Result> => {
  const watching = activeObserver()
  if (!watching) return work()

  const { observer, frame } = watching
  const runId = frame.handle.runId
  const summary = summarise(args)
  const startedAt = Date.now()

  try {
    observer.onSpanStart?.({ runId, name, args: summary })
  } catch {
    // deliberately ignored
  }

  try {
    const result = await work()

    try {
      observer.onSpanEnd?.({ runId, name, args: summary, durationMs: Date.now() - startedAt })
    } catch {
      // deliberately ignored
    }

    return result
  } catch (error) {
    try {
      observer.onSpanEnd?.({
        runId,
        name,
        args: summary,
        durationMs: Date.now() - startedAt,
        error,
      })
    } catch {
      // deliberately ignored
    }

    throw error
  }
}
