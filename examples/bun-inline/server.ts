import { createBooking, flow } from './booking.js'

/*
 * `bun run examples/bun-inline/server.ts`, then:
 *   curl -X POST 'http://localhost:3000/bookings?seat=12A'
 *   curl -X POST 'http://localhost:3000/bookings?seat=12A&confirm=false'   # undoes itself
 */
Bun.serve({
  port: 3000,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname !== '/bookings') return new Response('not found', { status: 404 })

    // One scope per request: the tenant and the actor come from the session, never from input.
    const scoped = flow.for({ tenantId: 'acme', actor: 'someone@example.com' })
    const result = await createBooking.try(
      {
        seat: url.searchParams.get('seat') ?? '',
        confirm: url.searchParams.get('confirm') !== 'false',
      },
      scoped,
    )

    if (!result.ok) return Response.json({ error: result.error.message }, { status: 409 })

    return Response.json(result.value, { status: 201 })
  },
})

console.info('listening on http://localhost:3000')
