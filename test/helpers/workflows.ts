import { defineWorkflow, type WorkflowHandle } from '../../src/index'
import type { TestRuntime } from './runtime'
import { markInput, markStep } from './steps'

// Three steps in a row, each undoable, with any one of them made to misbehave. Nearly every
// engine question — ordering, the step trail, the reverse unwinding, what a refusal costs —
// is asked of this one shape.
export const threeStepWorkflow = (
  options: {
    compensateFailsOn?: string
    failOn?: string
    withoutCompensationOn?: string
  } = {},
) => {
  const step = (name: string) =>
    markStep(name, {
      compensateFails: options.compensateFailsOn === name,
      fails: options.failOn === name,
      withoutCompensation: options.withoutCompensationOn === name,
    })

  const first = step('first')
  const second = step('second')
  const third = step('third')

  return defineWorkflow(
    { name: 'test.three-steps', input: markInput, execution: 'inline' },
    async (input: { mark: string }, wf: WorkflowHandle<TestRuntime>) => {
      await wf.step(first, input)
      await wf.step(second, input)
      const last = await wf.step(third, input)

      return { finished: last.seen }
    },
  )
}
