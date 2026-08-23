import type { Flow } from './flow.js'

let configured: Flow | undefined

/** Replace the instance used when a call is given none and is inside no scope. */
export const configureDefault = (instance: Flow): void => {
  configured = instance
}

/**
 * The instance a call falls back to.
 *
 * Created on first use, in memory — because the alternative is a quickstart that cannot run
 * without configuring anything, and the first thing anybody wants is to see a saga work.
 *
 * It says nothing about itself here. The instance owes exactly one line — that nothing is
 * durable — and the instance says it, through whatever `warn` it was given. Two pieces of code
 * each deciding the warning was theirs to say is how a reader ends up with two, in two
 * wordings, and stops reading both.
 */
export const defaultInstance = (): Flow => {
  if (configured) return configured

  // Imported here rather than at the top because flow.ts reaches back for this one.
  // eslint-disable-next-line
  configured = createDefault()

  return configured
}

let createDefault: () => Flow = () => {
  throw new Error('sagaflow was not initialised')
}

/** Wired once by flow.ts, which owns what an instance is. */
export const provideDefaultFactory = (factory: () => Flow): void => {
  createDefault = factory
}
