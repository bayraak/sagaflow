import { beforeEach, describe, expect, it } from 'bun:test'

import { flow, journal, listRuns, proposeRefund, state } from './tools'

describe('the agent-tools example', () => {
  beforeEach(() => {
    journal.runs.length = 0
    journal.steps.length = 0
    state.refunds.clear()
    state.ledger.length = 0
  })

  it('writes a proposal rather than sending the money', async () => {
    const proposed = await proposeRefund(
      { orderId: 'ord_1', amount: 42 },
      flow.for({ tenantId: 'acme', actor: 'agent-7' }),
    )

    expect(proposed).toEqual({ refundId: 'refund_1', awaiting: 'approval' })
    expect(state.refunds.get('refund_1')?.state).toBe('proposed')
  })

  it('is one proposal however many times the agent retries', async () => {
    const scoped = flow.for({ tenantId: 'acme', actor: 'agent-7' })

    await proposeRefund({ orderId: 'ord_1', amount: 42 }, scoped)
    await proposeRefund({ orderId: 'ord_1', amount: 42 }, scoped)

    expect(journal.runs).toHaveLength(1)
    expect(state.refunds.size).toBe(1)
  })

  it('refuses a proposal the schema will not accept, before any run exists', async () => {
    const scoped = flow.for({ tenantId: 'acme', actor: 'agent-7' })

    const result = await proposeRefund.try({ orderId: 'ord_1', amount: -1 }, scoped)

    expect(result.ok).toBe(false)
    expect(journal.runs).toEqual([])
    expect(state.refunds.size).toBe(0)
  })

  it('lets the agent read back what it did', async () => {
    const scoped = flow.for({ tenantId: 'acme', actor: 'agent-7' })
    await proposeRefund({ orderId: 'ord_2', amount: 7 }, scoped)

    const runId = journal.runs[0]?.id as string
    const seen = await listRuns('acme', [runId])

    expect(seen).toEqual([
      {
        id: runId,
        name: 'agent.propose-refund',
        status: 'completed',
        steps: ['draftRefund:completed', 'creditLedger:completed'],
      },
    ])
  })
})
