const unitMilliseconds: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  second: 1000,
  seconds: 1000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
}

/**
 * A duration in the form the durable platforms spell it — `'10 seconds'`, `'2 minutes'` — or
 * plain milliseconds. Only the inline executor needs to understand these; a durable platform
 * parses its own, and the string is passed to it untouched.
 */
export const millisecondsOf = (duration: number | string): number => {
  if (typeof duration === 'number') return duration

  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(duration)
  const unit = match?.[2] === undefined ? undefined : unitMilliseconds[match[2].toLowerCase()]

  if (match?.[1] === undefined || unit === undefined) {
    throw new Error(`"${duration}" is not a duration this can read`)
  }

  return Number(match[1]) * unit
}
