import type { RunJournal } from '../types.js'

/**
 * A run's trail as `name:status`, in order.
 *
 * The one-line assertion nearly every saga test wants, so nobody writes the same `.map()` twice
 * and nobody gets it subtly different — `['reserve:completed', 'boom:failed',
 * 'compensate:reserve:compensated']` is the whole story of a run that was undone.
 */
export const trailOf = async (options: {
  journal: RunJournal
  runId: string
  tenantId?: string
}): Promise<string[]> => {
  const listRunSteps = options.journal.listRunSteps
  if (!listRunSteps) {
    throw new Error('this journal cannot read its steps back: implement listRunSteps')
  }

  const steps = await listRunSteps({
    tenantId: options.tenantId ?? 'default',
    runId: options.runId,
  })

  return steps.map((step) => `${step.name}:${step.status}`)
}
