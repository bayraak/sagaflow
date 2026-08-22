import { SagaflowError } from '../errors'

/**
 * The conformance suite carries its own assertions so it can be run by any test runner — bun,
 * vitest, node:test, jest — without taking a dependency on one or assuming the shape of its
 * `expect`. A case fails by throwing, which every runner already understands.
 */
export class ConformanceFailure extends SagaflowError {
  constructor(message: string) {
    super(message)

    this.name = 'ConformanceFailure'
  }
}

const show = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export const assertThat = (claim: boolean, message: string): void => {
  if (!claim) throw new ConformanceFailure(message)
}

export const assertIs = (actual: unknown, expected: unknown, message: string): void => {
  if (!Object.is(actual, expected)) {
    throw new ConformanceFailure(`${message} — expected ${show(expected)}, got ${show(actual)}`)
  }
}

export const assertSame = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ConformanceFailure(`${message} — expected ${show(expected)}, got ${show(actual)}`)
  }
}

export const assertRefuses = async (
  act: () => Promise<unknown>,
  message: string,
): Promise<void> => {
  try {
    await act()
  } catch {
    return
  }

  throw new ConformanceFailure(message)
}
