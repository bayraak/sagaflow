import { createWorkflowEntrypoint } from '../src/cloudflare/index.js'
import { createD1Journal } from '../src/d1/index.js'
import { shipThing, type TestEnv, type TestRuntime } from './definitions.js'

const runtimeFor = (env: TestEnv, tenantId: string, actor: string | null): TestRuntime => ({
  tenantId,
  actor,
  journal: createD1Journal(env.DB),
  events: env.EVENTS,
  db: env.DB,
})

// The entrypoint helper, used exactly as a caller would use it. `class_name` in wrangler.jsonc
// points at this name.
export class SagaflowTestWorkflow extends createWorkflowEntrypoint<TestEnv, TestRuntime>({
  workflows: [shipThing],
  runtime: (env, params) => runtimeFor(env, params.tenantId, params.actor),
}) {}

export default {
  async fetch(request: Request, env: TestEnv): Promise<Response> {
    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenant') ?? 'tenant_a'
    const mark = url.searchParams.get('mark') ?? 'THING-1'
    const ctx = runtimeFor(env, tenantId, 'tester')

    if (url.pathname === '/inline') {
      const { saveThing } = await import('./definitions.js')
      const result = await saveThing.run({ input: { mark }, ctx })

      return Response.json(result)
    }

    if (url.pathname === '/inline-bad') {
      const { saveThingBadly } = await import('./definitions.js')
      const failure = await saveThingBadly
        .run({ input: { mark }, ctx })
        .then(() => null)
        .catch((error: unknown) => error)

      return Response.json({
        runId: (failure as { runId?: string }).runId ?? null,
        outcome: (failure as { outcome?: string }).outcome ?? null,
      })
    }

    if (url.pathname === '/durable') {
      const { startDurableWorkflow } = await import('../src/index.js')
      const started = await startDurableWorkflow({
        launcher: env.WORKFLOWS,
        definition: shipThing,
        input: { mark },
        ctx,
      })

      return Response.json(started)
    }

    return new Response('not found', { status: 404 })
  },

  // The consumer writes what it received into D1, because a test cannot reach inside a queue.
  async queue(batch: MessageBatch<{ id: string; type: string }>, env: TestEnv): Promise<void> {
    for (const message of batch.messages) {
      await env.DB.prepare('insert or ignore into delivered (id, type) values (?, ?)')
        .bind(message.body.id, message.body.type)
        .run()
      message.ack()
    }
  },
}
