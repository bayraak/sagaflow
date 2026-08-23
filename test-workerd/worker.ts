import { entrypointFor, workerFor } from '../src/cloudflare/index.js'
import { bindings, flow, flowFrom, saveThing, saveThingBadly, shipThing } from './definitions.js'

// The whole durable wiring, in one line — from a factory, because inside an instance there is
// no request, only `this.env`, and a host's scope is built from its bindings.
// `class_name` in wrangler.jsonc points at this name.
export class SagaflowTestWorkflow extends entrypointFor(flowFrom) {}

// And the whole worker: a fetch handler, and everything else this library needs in every worker
// that uses it.
export default workerFor(flowFrom, {
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
