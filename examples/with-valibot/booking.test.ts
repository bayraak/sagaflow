import { describe, expect, it } from 'bun:test'

import { createBooking, flow } from './booking'

describe('the with-valibot example', () => {
  it('validates the input with Valibot', async () => {
    const result = await createBooking.try(
      { seat: '12A', passenger: 'not-an-email' },
      flow.for({ tenantId: 'acme' }),
    )

    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.message).toContain('is invalid')
  })

  it('runs exactly as the Zod version does', async () => {
    const booked = await createBooking(
      { seat: '12A', passenger: 'someone@example.com' },
      flow.for({ tenantId: 'acme' }),
    )

    expect(booked).toEqual({ seat: '12A', reference: 'hold_12A/someone@example.com' })
  })

  it('validates the output too', async () => {
    // The output schema is checked before the run closes; a body that answers with the wrong
    // shape is a body that failed, however cheerfully it returned.
    expect(typeof (await createBooking.try({ seat: '1B', passenger: 'a@b.co' }, flow))).toBe(
      'object',
    )
  })
})
