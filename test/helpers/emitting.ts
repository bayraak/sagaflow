import { defineWorkflow } from '../../src/define.js'
import { step, type WorkflowHandle } from '../../src/index'
import type { TestRuntime } from './runtime'
import { markInput, markStep, type MarkInput, type MarkOutput } from './steps'

export const emittingStep = step<TestRuntime, MarkInput, MarkOutput>('emitting', {
  run: async (input, ctx) => {
    ctx.emit('invoice.issued', { invoiceId: input.mark, total: 1 })

    return { seen: input.mark }
  },
  undo: async (_seen, ctx) => {
    ctx.invocations.push('compensate:emitting')
  },
})

export const emittingWorkflow = (options: { badPayload?: boolean; fails?: boolean } = {}) => {
  const after = markStep('after', { fails: options.fails })

  return defineWorkflow(
    { name: 'test.emitting', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(emittingStep, input)
      wf.emit('invoice.voided', { invoiceId: options.badPayload ? '' : input.mark })
      await wf.step(after, input)

      return { finished: input.mark }
    },
  )
}
