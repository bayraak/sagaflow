import { createStep, defineWorkflow, type WorkflowHandle } from '../../src/index'
import type { TestRuntime } from './runtime'
import { markInput, type MarkInput, type MarkOutput, type MarkUndo } from './steps'

const edgeStep = (
  name: string,
  options: { compensateFails?: boolean; emitsWhileUndoing?: boolean; fails?: boolean } = {},
) =>
  createStep<TestRuntime, MarkInput, MarkOutput, MarkUndo>(name, {
    run: async (input, ctx) => {
      ctx.invocations.push(`invoke:${name}`)
      if (options.fails) throw new Error(`${name} refused`)

      return { output: { seen: `${name}:${input.mark}` }, compensateWith: { undo: name } }
    },
    compensate: async (undo, ctx) => {
      ctx.invocations.push(`compensate:${undo.undo}`)
      if (options.emitsWhileUndoing) {
        ctx.emit('invoice.issued', { invoiceId: `undone-${undo.undo}`, total: 0 })
      }
      if (options.compensateFails) throw new Error(`${name} could not be undone`)
    },
  })

// Three steps, the last one refusing, so every suite that uses this starts from a run that has
// real work to undo.
export const failingWorkflow = (
  options: {
    compensateFailsOn?: 'all' | 'first' | 'second'
    emitsBeforeFailing?: boolean
    emitsWhileUndoingOn?: string
  } = {},
) => {
  const undoing = (name: string) =>
    edgeStep(name, {
      compensateFails: options.compensateFailsOn === 'all' || options.compensateFailsOn === name,
      emitsWhileUndoing: options.emitsWhileUndoingOn === name,
    })

  const first = undoing('first')
  const second = undoing('second')
  const third = edgeStep('third', { fails: true })

  return defineWorkflow(
    { name: 'edge.failing', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(first, input)
      await wf.step(second, input)
      if (options.emitsBeforeFailing) {
        wf.emit('invoice.voided', { invoiceId: input.mark })
      }
      await wf.step(third, input)

      return { finished: input.mark }
    },
  )
}

export const completingWorkflow = () => {
  const only = edgeStep('only')

  return defineWorkflow(
    { name: 'edge.completing', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      const seen = await wf.step(only, input)
      wf.emit('invoice.voided', { invoiceId: input.mark })

      return { finished: seen.seen }
    },
  )
}

export const durableCompletingWorkflow = () => {
  const only = edgeStep('only')

  return defineWorkflow(
    { name: 'edge.durable-completing', input: markInput, execution: 'durable' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      const seen = await wf.step(only, input)
      wf.emit('invoice.voided', { invoiceId: input.mark })

      return { finished: seen.seen }
    },
  )
}
