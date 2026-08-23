import { describe, expect, it } from 'bun:test'

import { ctx, definitionOf, saga, sagaflow } from 'sagaflow-js'

import { createMemoryJournal } from '../src/memory/index'

/*
 * A scope is built in layers, and each layer knows a different thing.
 *
 * A worker knows its bindings at module scope — the database handle, the query helpers, the
 * clients — and knows nothing about who is asking. A request knows the tenant and the actor and
 * nothing about bindings. A durable instance knows neither at the point the class is defined:
 * it gets its env when it is invoked and its tenant from the run it was started for.
 *
 * So `for` is called more than once on the way in, and each call has to ADD what it knows. A
 * `for` that replaced everything meant the last caller had to know what every earlier one had
 * put there, which is exactly the coupling scoping exists to remove — and it fails silently,
 * because the body sees `undefined` rather than an error.
 */
const configured = () => sagaflow({ journal: createMemoryJournal().journal, warn: () => undefined })

describe('a scope built in layers', () => {
  it('keeps what an earlier layer put there', async () => {
    const seen: Record<string, unknown>[] = []
    const look = saga('scope.look', async () => {
      seen.push(ctx())
    })

    await look({}, configured().for({ db: 'DB' }).for({ tenantId: 'acme' }))

    expect(seen[0]).toEqual({ tenantId: 'acme', actor: null, db: 'DB' })
  })

  it('lets a later layer overwrite a key an earlier one set', async () => {
    const seen: Record<string, unknown>[] = []
    const look = saga('scope.overwrite', async () => {
      seen.push(ctx())
    })

    await look({}, configured().for({ db: 'first' }).for({ db: 'second', tenantId: 'acme' }))

    expect(seen[0]).toEqual({ tenantId: 'acme', actor: null, db: 'second' })
  })

  it('carries the tenant and the actor forward when a later layer says nothing about them', async () => {
    const seen: Record<string, unknown>[] = []
    const look = saga('scope.carry', async () => {
      seen.push(ctx())
    })

    await look({}, configured().for({ tenantId: 'acme', actor: 'ada' }).for({ db: 'DB' }))

    expect(seen[0]).toEqual({ tenantId: 'acme', actor: 'ada', db: 'DB' })
  })

  it('scopes the same way inside flow.scope', async () => {
    const seen: Record<string, unknown>[] = []
    const look = saga('scope.inside', async () => {
      seen.push(ctx())
    })
    const flow = configured().for({ db: 'DB' })

    await flow.scope({ tenantId: 'acme' }, async () => {
      await look({})
    })

    expect(seen[0]).toEqual({ tenantId: 'acme', actor: null, db: 'DB' })
  })
})

describe('reaching a saga’s durable definition', () => {
  it('answers with the definition a durable saga was built from', () => {
    const ship = saga('scope.ship', { durable: true }, async () => undefined)

    expect(definitionOf(ship)?.name).toBe('scope.ship')
  })

  it('answers with nothing for a saga that has no instance to start', () => {
    const write = saga('scope.write', async () => undefined)

    expect(definitionOf(write)).toBeUndefined()
  })
})
