import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

type Env = { DB: D1Database; EVENTS: Queue<unknown>; BOOKINGS: Workflow }

type Params = { seat: string; card: string; email: string; tenantId: string; runId: string }

type Undo = { name: string; run: () => Promise<void> }

const nowMs = (): number => Date.now()

/*
 * Cloudflare Workflows gives durability: a step that completed is not run again, and an
 * instance survives a deploy. It does not give compensation, a run record of your own, an
 * idempotency claim scoped to your tenant, or an outbox — so all of that is still here, and it
 * is the same code as the hand-rolled version, indented one level further in.
 */
export class BookingWorkflow extends WorkflowEntrypoint<Env, Params> {
  override async run(
    event: WorkflowEvent<Params>,
    step: WorkflowStep,
  ): Promise<{ holdId: string }> {
    const { runId, tenantId } = event.payload
    const undos: Undo[] = []
    let seq = 0

    const record = async (name: string, status: string, error?: string): Promise<void> => {
      await this.env.DB.prepare(
        `insert into run_steps (run_id, seq, name, status, error) values (?, ?, ?, ?, ?)`,
      )
        .bind(runId, seq++, name, status, error ?? null)
        .run()
    }

    // The undo has to be rebuilt from what the step RETURNED. On a re-invocation the platform
    // answers a completed step from its journal without running the body, so a closure taken
    // inside the step no longer exists — and the undo that lived in it is gone, silently, for
    // exactly the runs that most need undoing.
    const perform = async <Output extends Rpc.Serializable<Output>>(
      name: string,
      work: () => Promise<Output>,
      undo?: (output: Output) => Promise<void>,
    ): Promise<Output> => {
      const output = await step.do(name, async () => {
        try {
          const produced = await work()
          await record(name, 'completed')

          return produced
        } catch (error) {
          await record(name, 'failed', error instanceof Error ? error.message : String(error))

          throw error
        }
      })
      if (undo) undos.push({ name, run: () => undo(output) })

      return output
    }

    const unwind = async (): Promise<'compensated' | 'failed'> => {
      let outcome: 'compensated' | 'failed' = 'compensated'

      for (const undo of undos.toReversed()) {
        // Each undo is itself a step, or a retry of the workflow re-runs undos that already
        // happened — a refund issued twice is worse than the failure that caused it.
        try {
          await step.do(`compensate-${undo.name}`, async () => {
            await undo.run()
            await record(`compensate:${undo.name}`, 'compensated')
          })
        } catch (error) {
          outcome = 'failed'
          await record(
            `compensate:${undo.name}`,
            'failed',
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      return outcome
    }

    try {
      const held = await perform(
        'hold-seat',
        () => holdSeat(event.payload.seat),
        (hold) => releaseSeat(hold.id),
      )
      const charge = await perform(
        'charge-card',
        () => chargeCard(event.payload.card, held.price),
        (paid) => refund(paid.id),
      )
      await perform('send-confirmation', () => sendConfirmation(event.payload.email, held.id))

      const output = { holdId: held.id }

      // Closing the run and queueing its event is one batch, and the whole thing is a step, so
      // an instance invoked again does not close the run twice.
      await step.do('finish', async () => {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `update runs set status = 'completed', output = ?, finished_at = ? where id = ?`,
          ).bind(JSON.stringify(output), nowMs(), runId),
          this.env.DB.prepare(
            `insert into outbox (id, tenant_id, run_id, type, payload, occurred_at)
             values (?, ?, ?, 'booking.created', ?, ?)`,
          ).bind(
            `${runId}:0`,
            tenantId,
            runId,
            JSON.stringify({ holdId: held.id, chargeId: charge.id }),
            nowMs(),
          ),
        ])
      })

      await step.do('announce', async () => {
        await this.env.EVENTS.sendBatch([
          { body: { id: `${runId}:0`, type: 'booking.created', payload: output } },
        ])
        await this.env.DB.prepare(`update outbox set dispatched_at = ? where id = ?`)
          .bind(nowMs(), `${runId}:0`)
          .run()
      })

      return output
    } catch (error) {
      const outcome = await unwind()
      const message = error instanceof Error ? error.message : String(error)

      await step.do('finish-badly', async () => {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `update runs set status = ?, error = ?, finished_at = ? where id = ?`,
          ).bind(outcome, message, nowMs(), runId),
          this.env.DB.prepare(
            `insert into outbox (id, tenant_id, run_id, type, payload, occurred_at)
             values (?, ?, ?, 'booking.failed', ?, ?)`,
          ).bind(`${runId}:0`, tenantId, runId, JSON.stringify({ runId, outcome }), nowMs()),
        ])
      })

      throw error
    }
  }
}

/*
 * And the caller. An instance cannot open its own run record — it does not exist until the
 * platform says so — so the row, the idempotency claim and the instance id all have to be
 * arranged out here, before the workflow is started.
 */
export const book = async (
  env: Env,
  input: { seat: string; card: string; email: string },
  tenantId: string,
): Promise<{ runId: string }> => {
  const runId = crypto.randomUUID()
  const key = `booking.create:${tenantId}:${input.seat}`

  try {
    await env.DB.prepare(
      `insert into runs (id, tenant_id, name, status, idempotency_key, input, started_at)
       values (?, ?, 'booking.create', 'running', ?, ?, ?)`,
    )
      .bind(runId, tenantId, key, JSON.stringify(input), nowMs())
      .run()
  } catch {
    const held = await env.DB.prepare(
      `select id from runs
       where tenant_id = ? and idempotency_key = ? and status in ('running', 'completed')`,
    )
      .bind(tenantId, key)
      .first<{ id: string }>()
    if (!held) throw new Error('the run could not be opened')

    return { runId: held.id }
  }

  try {
    // Per tenant, or one tenant's booking deduplicates another's.
    await env.BOOKINGS.create({ id: `${tenantId}:${runId}`, params: { ...input, tenantId, runId } })
  } catch (error) {
    // The row is open and no instance will ever close it. Nothing else is going to notice.
    await env.DB.prepare(
      `update runs set status = 'failed', error = ?, finished_at = ? where id = ?`,
    )
      .bind(error instanceof Error ? error.message : String(error), nowMs(), runId)
      .run()

    throw error
  }

  return { runId }
}

declare function holdSeat(seat: string): Promise<{ id: string; price: number }>
declare function releaseSeat(id: string): Promise<void>
declare function chargeCard(card: string, amount: number): Promise<{ id: string }>
declare function refund(id: string): Promise<void>
declare function sendConfirmation(email: string, holdId: string): Promise<void>
