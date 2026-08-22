import type { Flow } from './flow.js'

let configured: Flow | undefined
let announced = false

/** Replace the instance used when a call is given none and is inside no scope. */
export const configureDefault = (instance: Flow): void => {
  configured = instance
}

/**
 * The instance a call falls back to.
 *
 * Created on first use, in memory, with one line saying so — because the alternative is a
 * quickstart that cannot run without configuring anything, and the first thing anybody wants is
 * to see a saga work.
 */
export const defaultInstance = (): Flow => {
  if (configured) return configured

  if (!announced) {
    announced = true
    console.info(
      'sagaflow: using the in-memory default — call sagaflow({ journal }) for anything real',
    )
  }

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
