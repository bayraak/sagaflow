import { beforeEach, describe, expect, it } from 'bun:test'

import { createBooking, delivered, flow, journal, state } from './booking'

describe('the bun-inline example', () => {
  beforeEach(() => {
    journal.runs.length = 0
    journal.steps.length = 0
    delivered.length = 0
    state.seats.clear()
    state.charges.clear()
  })

  it('books a seat and announces it', async () => {
    const booked = await createBooking({ seat: '12A' }, flow.for({ tenantId: 'acme' }))

    expect(booked).toEqual({ seat: '12A', chargeId: 'ch_4200_0' })
    expect(journal.runs[0]).toMatchObject({ name: 'booking.create', status: 'completed' })
    expect(journal.steps.map((row) => row.name)).toEqual(['reserveSeat', 'chargeCard'])
    expect(delivered).toEqual(['booking.created', 'workflow.completed'])
  })

  it('undoes everything when the booking is not confirmed', async () => {
    const result = await createBooking.try(
      { seat: '12A', confirm: false },
      flow.for({ tenantId: 'acme' }),
    )

    expect(result.ok).toBe(false)
    expect(state.seats.size).toBe(0)
    expect(state.charges.size).toBe(0)
    expect(journal.runs[0]?.status).toBe('compensated')
    expect(journal.steps.map((row) => row.name)).toEqual([
      'reserveSeat',
      'chargeCard',
      'compensate:chargeCard',
      'compensate:reserveSeat',
    ])
    // A run that was undone announces itself, and nothing the body emitted.
    expect(delivered).toEqual([])
  })
})
