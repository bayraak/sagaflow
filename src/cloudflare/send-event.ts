import { instanceIdFor } from '../start.js'

/** A handle on one running instance, narrowed to the one thing an approval endpoint does. */
export type WorkflowInstanceHandle = {
  sendEvent(options: { type: string; payload: unknown }): Promise<void>
}

/** Structurally a Cloudflare Workflow binding, narrowed to looking an instance up. */
export type WorkflowInstanceLookup = {
  get(id: string): Promise<WorkflowInstanceHandle>
}

/**
 * Wake a durable run that is waiting for an event.
 *
 * The point of this existing at all is the id. An instance is created under
 * `instanceIdFor(name, runId)`, and an approval endpoint that built that string by hand would
 * be a second copy of a format that must never drift — the day the format changes, every
 * waiting run becomes unreachable and nothing fails loudly. So the caller names the run, not
 * the instance.
 */
export const sendWorkflowEvent = async (options: {
  binding: WorkflowInstanceLookup
  name: string
  runId: string
  event: { type: string; payload: unknown }
}): Promise<void> => {
  const instance = await options.binding.get(instanceIdFor(options.name, options.runId))

  await instance.sendEvent(options.event)
}
