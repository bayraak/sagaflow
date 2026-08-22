/// <reference types="@cloudflare/workers-types" />

import type {
  WorkflowSleepDuration,
  WorkflowStep,
  WorkflowStepConfig,
  WorkflowStepContext,
  WorkflowTimeoutDuration,
} from 'cloudflare:workers'

import type { StepPrimitive, StepRetryConfig } from '../types.js'

/**
 * The `StepPrimitive` seam, implemented over a real workflow instance's step object. This
 * adapter is the only place in the package that knows the durable executor runs on Cloudflare
 * Workflows — which is exactly what lets that executor be tested without a worker runtime, and
 * what makes an adapter for another platform about twenty lines.
 *
 * It is also where two type systems meet. sagaflow describes a step in plain TypeScript so the
 * core needs no platform types at all; the platform describes one in terms of what it can
 * checkpoint and how it spells a duration. The assertions below are that translation, and each
 * is checked for real by the runtime: an output it cannot serialise and a duration it cannot
 * parse are both refused at the step.
 */
export const createStepPrimitive = (step: WorkflowStep): StepPrimitive => ({
  do: <Output>(
    name: string,
    config: StepRetryConfig,
    run: (context: { attempt: number }) => Promise<Output>,
  ): Promise<Output> => {
    const callback = (context: WorkflowStepContext): Promise<Output> =>
      run({ attempt: context.attempt })

    return step.do(
      name,
      config as WorkflowStepConfig,
      callback as (context: WorkflowStepContext) => Promise<never>,
    )
  },
  sleep: (name, duration) => step.sleep(name, duration as WorkflowSleepDuration),
  waitForEvent: async <Payload>(
    name: string,
    options: { type: string; timeout?: string },
  ): Promise<Payload> => {
    const received = await step.waitForEvent(name, {
      type: options.type,
      ...(options.timeout === undefined
        ? {}
        : { timeout: options.timeout as WorkflowTimeoutDuration }),
    })

    // sagaflow hands a body the payload, not the platform's envelope around it.
    return received.payload as Payload
  },
})
