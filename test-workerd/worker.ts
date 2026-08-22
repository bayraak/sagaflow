import { entrypointFor, workerFor } from '../src/cloudflare/index.js'
import { bindings, flow, saveThing, saveThingBadly, shipThing } from './definitions.js'

// The whole durable wiring, in one line. `class_name` in wrangler.jsonc points at this name.
export class SagaflowTestWorkflow extends entrypointFor(flow) {}

// And the whole worker: a fetch handler, and everything else this library needs in every worker
// that uses it.
export default workerFor(flow, {
  onEvent: async (envelope) => {
    await bindings.DB.prepare('insert or ignore into delivered (id, type) values (?, ?)')
      .bind(envelope.id, envelope.type)
      .run()
  },
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenant') ?? 'tenant_a'
    const mark = url.searchParams.get('mark') ?? 'THING-1'
    const scoped = flow.for({ tenantId, actor: 'tester' })

    if (url.pathname === '/inline') return Response.json(await saveThing({ mark }, scoped))
    if (url.pathname === '/inline-bad') {
      return Response.json(await saveThingBadly.try({ mark }, scoped))
    }
    if (url.pathname === '/durable') {
      return Response.json(await shipThing.start({ mark }, scoped))
    }

    return new Response('not found', { status: 404 })
  },
})
