import type { DurableWorkflowEnv, DurableWorkflowParams } from '../../src/index'

export const createLauncher = (options: { refusesWith?: Error } = {}) => {
  const created: { id?: string; params?: DurableWorkflowParams }[] = []

  const env: DurableWorkflowEnv = {
    WORKFLOWS: {
      create: async (instance) => {
        if (options.refusesWith) throw options.refusesWith

        created.push(instance)

        return { id: instance.id ?? 'generated' }
      },
    },
  }

  return { env, created }
}
