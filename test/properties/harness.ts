import * as fc from 'fast-check'

/*
 * The guarantees, checked against inputs nobody chose.
 *
 * An example test proves the engine handles the case its author thought of. A property states
 * the rule and lets a generator look for the case nobody thought of — a five-step run failing
 * at the fourth with the second's undo refusing, a journal that gives out on the third write, a
 * queue that delivers the same batch twice and forgets to say so. Each file here states one of
 * the four guarantees as a rule over generated scenarios, and each of them also proves that the
 * rule it states can tell a right answer from a wrong one: a property that accepts everything
 * passes for ever and means nothing.
 *
 * Every property prints its seed. A failure is reproducible by running it again with
 * SAGAFLOW_PROPERTY_SEED set to the printed number, and fast-check will shrink the counterexample
 * to the smallest scenario that still breaks the rule.
 */

const readInteger = (name: string, fallback: number): number => {
  const given = process.env[name]
  if (given === undefined || given.trim() === '') return fallback

  const parsed = Number(given)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a whole number, got ${JSON.stringify(given)}`)
  }

  return parsed
}

/**
 * The seed the whole file's properties run under, printed beside every claim.
 *
 * It is different on every run on purpose. A fixed seed tests the same few hundred scenarios
 * for ever and stops finding anything on its second day; a moving one keeps looking, and the
 * printed number is what makes a find reproducible. Set `SAGAFLOW_PROPERTY_SEED` to pin it.
 */
export const propertySeed = readInteger('SAGAFLOW_PROPERTY_SEED', Date.now() % 0x7fff_ffff)

/**
 * How many scenarios each property tries. Two hundred is what a pull request can afford to wait
 * for; `SAGAFLOW_PROPERTY_RUNS` raises it for a nightly job or for hunting something down, and
 * cannot lower it, because a property that ran twenty times has not been asked a question.
 */
export const propertyTrials = Math.max(200, readInteger('SAGAFLOW_PROPERTY_RUNS', 200))

/**
 * Run one property and say, on the way in, what it is checking and under which seed — so a
 * failure in someone else's CI log carries everything needed to reproduce it.
 */
export const assertProperty = async <Ts>(
  claim: string,
  property: fc.IAsyncProperty<Ts>,
): Promise<void> => {
  console.info(`[property] ${claim} · ${propertyTrials} trials · seed ${propertySeed}`)

  await fc.assert(property, { numRuns: propertyTrials, seed: propertySeed })
}

/**
 * What the trials actually reached.
 *
 * A generator drifts. Someone tightens a bound, someone adds a field, and a property that used
 * to exercise four outcomes quietly exercises one — still green, still passing, no longer
 * asking anything. So each property names the situations it exists to cover and fails if a run
 * never got to one of them. This is the difference between "the property passed" and "the
 * property was put to work".
 */
export type Coverage = {
  saw(situation: string): void
  /** Fail unless every named situation came up at least once, saying what did come up. */
  reached(...required: string[]): void
}

export const createCoverage = (): Coverage => {
  const counts = new Map<string, number>()

  return {
    saw: (situation) => counts.set(situation, (counts.get(situation) ?? 0) + 1),
    reached: (...required) => {
      const missed = required.filter((situation) => !counts.has(situation))
      if (missed.length === 0) return

      const seen = [...counts.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([situation, count]) => `${situation} ×${count}`)

      throw new Error(
        `${propertyTrials} trials never reached ${missed.join(', ')} — ` +
          `reached: ${seen.join(', ') || 'nothing at all'}`,
      )
    },
  }
}
