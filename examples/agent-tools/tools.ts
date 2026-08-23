import { action, saga, sagaflow, step } from 'sagaflow-js'
import { createMemoryJournal } from 'sagaflow-js/memory'
import { z } from 'zod'

/*
 * MCP-style tools for an agent, on sagaflow.
 *
 * The rule an agent backend needs is "reads run, writes propose". A read is a query. A write is a
 * saga: recorded, undoable, idempotent, and announced once. And the action nobody can take back —
 * sending the money, sending the email — is not taken by the agent at all: the agent writes a
 * PROPOSAL, and a person approves it.
 */

const refunds = new Map<string, { orderId: string; amount: number; state: string }>()
const ledger: { orderId: string; amount: number }[] = []

const draftRefund = action(
  async function draftRefund(input: { orderId: string; amount: number }) {
    const id = `refund_${refunds.size + 1}`
    refunds.set(id, { ...input, state: 'proposed' })

    return { id }
  },
  {
    // Undoable, because it is only a row. That is the whole reason the proposal exists.
    undo: (drafted) => {
      refunds.delete(drafted.id)
    },
  },
)

const creditLedger = action(
  async function creditLedger(input: { orderId: string; amount: number }) {
    ledger.push(input)

    return { entries: ledger.length }
  },
  {
    undo: () => {
      ledger.pop()
    },
  },
)

/** A WRITE tool. Everything it does is undoable, and it stops at the point of no return. */
export const proposeRefund = saga(
  'agent.propose-refund',
  {
    input: z.object({ orderId: z.string().min(1), amount: z.number().positive() }),
    // The same proposal asked for twice is one proposal, however many times the agent retries.
    idempotent: true,
  },
  async (input) => {
    const drafted = await draftRefund(input)
    await creditLedger(input)

    return { refundId: drafted.id, awaiting: 'approval' as const }
  },
)

/**
 * The irreversible half, and the only place it lives. A durable saga that waits for a human,
 * for up to a week, holding nothing open while it waits.
 */
export const settleRefund = saga(
  'agent.settle-refund',
  { input: z.object({ refundId: z.string().min(1) }), durable: true, idempotent: true },
  async (input) => {
    const approval = await waitForApproval(input.refundId)
    if (!approval.approved) return { settled: false }

    // Past this line nothing is undoable, which is why nothing else is past this line.
    await step('send-money', async () => {
      const refund = refunds.get(input.refundId)
      if (refund) refunds.set(input.refundId, { ...refund, state: 'settled' })
    })

    return { settled: true }
  },
)

const waitForApproval = async (refundId: string): Promise<{ approved: boolean }> => {
  const { waitForEvent } = await import('sagaflow-js')

  return waitForEvent<{ approved: boolean }>(`approval-${refundId}`, {
    type: 'refund.approved',
    timeout: '7 days',
  })
}

/** A READ tool. No saga, because reading changes nothing. */
export const listRuns = async (
  tenantId: string,
  runIds: string[],
): Promise<{ id: string; name: string; status: string; steps: string[] }[]> => {
  const scoped = flow.for({ tenantId })
  const reports = await Promise.all(runIds.map((runId) => scoped.inspect(runId)))

  return reports
    .filter((report): report is NonNullable<typeof report> => report !== null)
    .map((report) => ({
      id: report.id,
      name: report.name,
      status: report.status,
      steps: report.steps.map((row) => `${row.name}:${row.status}`),
    }))
}

export const journal = createMemoryJournal()
export const flow = sagaflow({
  journal: journal.journal,
  sagas: [proposeRefund, settleRefund],
})

export const state = { refunds, ledger }
