import type { DurableWorkflowParams, WorkflowLauncher } from '../../src/index'

export const createLauncher = (options: { refusesWith?: Error } = {}) => {
  const created: { id?: string; params?: DurableWorkflowParams }[] = []

  const launcher: WorkflowLauncher = {
    create: async (instance) => {
      if (options.refusesWith) throw options.refusesWith

      created.push(instance)

      return { id: instance.id ?? 'generated' }
    },
  }

  return { launcher, created }
}
