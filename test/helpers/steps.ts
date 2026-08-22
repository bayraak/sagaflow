import { z } from 'zod'

import { createStep, type StepBudget } from '../../src/index'
import type { TestRuntime } from './runtime'

export const markInput = z.object({ mark: z.string().min(1) })

export type MarkInput = { mark: string }
export type MarkOutput = { seen: string }

// One shape of step, configurable into every way a step can behave, so a suite reads as the
// scenario it is testing rather than as a pile of near-identical fixtures.
export const markStep = (
  name: string,
  options: {
    budget?: StepBudget
    compensateFails?: boolean
    fails?: boolean
    withoutCompensation?: boolean
  } = {},
) =>
  createStep<TestRuntime, MarkInput, MarkOutput>(name, {
    run: async (input, ctx) => {
      ctx.invocations.push(`invoke:${name}`)
      if (options.fails) throw new Error(`${name} refused`)

      return { seen: `${name}:${input.mark}` }
    },
    compensate: options.withoutCompensation
      ? undefined
      : async (_seen, ctx) => {
          ctx.invocations.push(`compensate:${name}`)
          if (options.compensateFails) throw new Error(`${name} could not be undone`)
        },
    ...options.budget,
  })
