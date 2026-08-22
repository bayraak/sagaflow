import { entrypointFor, workerFor } from '@bayraak/sagaflow/cloudflare'

import { chaseBooking, createBooking, flow } from './sagas.js'

// One class for every durable saga you have. `class_name` in wrangler.jsonc points at this name.
export class Sagas extends entrypointFor(flow) {}

// fetch is yours; queue and scheduled are the two handlers every sagaflow worker needs.
export default workerFor(flow, {
  onEvent: async (envelope) => {
    await flow.runtime.journal.markEventsDispatched({
      tenantId: envelope.tenantId,
      ids: [envelope.id],
    })
  },
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const seat = url.searchParams.get('seat') ?? '12A'
    const scoped = flow.for({ tenantId: 'acme', actor: 'someone@example.com' })

    if (url.pathname === '/bookings') {
      const result = await createBooking.try({ seat }, scoped)

      return result.ok
        ? Response.json(result.value, { status: 201 })
        : Response.json({ error: result.error.message }, { status: 409 })
    }

    if (url.pathname === '/chase') return Response.json(await chaseBooking.start({ seat }, scoped))

    return new Response('not found', { status: 404 })
  },
})
