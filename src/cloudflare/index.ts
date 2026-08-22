/**
 * The Cloudflare adapter: a `StepPrimitive` over Cloudflare Workflows, an entrypoint class that
 * dispatches by name, and a way to wake a waiting run.
 *
 * Importing this module pulls in `cloudflare:workers`, so it only resolves inside a Worker.
 * Everything else in the package runs anywhere.
 */
export { createWorkflowEntrypoint, type WorkflowEntrypointClass } from './entrypoint.js'
export {
  sendWorkflowEvent,
  type WorkflowInstanceHandle,
  type WorkflowInstanceLookup,
} from './send-event.js'
export { createStepPrimitive } from './step-primitive.js'
