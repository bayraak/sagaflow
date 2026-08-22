import { describe, expect, it } from 'bun:test'

import { createStep, namedStep, reservedStepNames } from '../src/index'

const anyStep = (name: string) =>
  createStep<unknown, void, void>(name, { run: async () => undefined })

// The engine runs steps of its own — the finish and the drain — and names every compensation
// after the step it reverses. A caller's step under one of those names would be handed the
// engine's memoised result on a replay, or hand the engine its own. Refusing the name at
// definition time turns a three-in-the-morning debugging session into a stack trace on the
// line that caused it.
describe('the names the engine keeps for itself', () => {
  it('refuses a step named after one of them', () => {
    for (const reserved of Object.values(reservedStepNames)) {
      expect(() => anyStep(reserved)).toThrow(`"${reserved}" is a reserved step name`)
    }
  })

  it('refuses a step borrowed under one of them', () => {
    const step = anyStep('honest')

    for (const reserved of Object.values(reservedStepNames)) {
      expect(() => namedStep(step, reserved)).toThrow('reserved')
    }
  })

  it('refuses a step that claims to be a compensation', () => {
    expect(() => anyStep('compensate:charge')).toThrow('reserved')
    expect(() => namedStep(anyStep('honest'), 'compensate:charge')).toThrow('reserved')
  })

  it('allows every other name, including ones that merely resemble them', () => {
    expect(anyStep('finish-run-report').name).toBe('finish-run-report')
    expect(anyStep('compensation').name).toBe('compensation')
  })
})
