type Env = { DB: D1Database; EVENTS: Queue<unknown> }

declare const env: Env

type Undo = { name: string; run: () => Promise<void> }

const nowMs = (): number => Date.now()

export const book = async (
  input: { seat: string; card: string; email: string },
  tenantId: string,
): Promise<{ holdId: string }> => {
  const runId = crypto.randomUUID()
  const key = `booking.create:${tenantId}:${input.seat}`
  const undos: Undo[] = []
  const events: { id: string; type: string; payload: unknown }[] = []
  let seq = 0

  // Claim the key. A partial unique index on (tenant_id, idempotency_key) where the status is
  // still standing is what makes this a claim rather than a race; the insert failing is the
  // signal that somebody already asked.
  try {
    await env.DB.prepare(
      `insert into runs (id, tenant_id, name, status, idempotency_key, input, started_at)
       values (?, ?, 'booking.create', 'running', ?, ?, ?)`,
    )
      .bind(runId, tenantId, key, JSON.stringify(input), nowMs())
      .run()
  } catch {
    const held = await env.DB.prepare(
      `select id, status, output from runs
       where tenant_id = ? and idempotency_key = ? and status in ('running', 'completed')`,
    )
      .bind(tenantId, key)
      .first<{ id: string; status: string; output: string | null }>()
    if (!held) throw new Error('the run could not be opened')
    if (held.status === 'running') throw new Error('that booking is already in flight')

    return JSON.parse(held.output ?? '{}') as { holdId: string }
  }

  const record = async (name: string, status: string, error?: string): Promise<void> => {
    await env.DB.prepare(
      `insert into run_steps (run_id, seq, name, status, error) values (?, ?, ?, ?, ?)`,
    )
      .bind(runId, seq++, name, status, error ?? null)
      .run()
  }

  const perform = async <Output>(
    name: string,
    work: () => Promise<Output>,
    undo?: (output: Output) => Promise<void>,
  ): Promise<Output> => {
    try {
      const output = await work()
      await record(name, 'completed')
      // Registered from the RETURNED value, never from a closure, so the undo has what it
      // needs even when the value came from somewhere other than this call.
      if (undo) undos.push({ name, run: () => undo(output) })

      return output
    } catch (error) {
      await record(name, 'failed', error instanceof Error ? error.message : String(error))

      throw error
    }
  }

  // Undo everything that completed, in reverse, attempting every one even after a refusal —
  // the undo behind a refused one is the last thing between a customer and a half-made booking.
  const unwind = async (): Promise<'compensated' | 'failed'> => {
    let outcome: 'compensated' | 'failed' = 'compensated'

    for (const undo of undos.toReversed()) {
      try {
        await undo.run()
        await record(`compensate:${undo.name}`, 'compensated')
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
      () => holdSeat(input.seat),
      (hold) => releaseSeat(hold.id),
    )
    const charge = await perform(
      'charge-card',
      () => chargeCard(input.card, held.price),
      (paid) => refund(paid.id),
    )
    await perform('send-confirmation', () => sendConfirmation(input.email, held.id))

    events.push({
      // Deterministic, so a second write of this run's events lands on rows that already exist
      // instead of handing the consumer a copy it cannot recognise.
      id: `${runId}:0`,
      type: 'booking.created',
      payload: { holdId: held.id, chargeId: charge.id },
    })

    const output = { holdId: held.id }

    // The run closes and its events are queued in ONE batch. Two batches would make
    // "completed, and nobody was ever told" a state this code can produce.
    await env.DB.batch([
      env.DB.prepare(
        `update runs set status = 'completed', output = ?, finished_at = ? where id = ?`,
      ).bind(JSON.stringify(output), nowMs(), runId),
      ...events.map((event) =>
        env.DB.prepare(
          `insert into outbox (id, tenant_id, run_id, type, payload, occurred_at)
           values (?, ?, ?, ?, ?, ?)`,
        ).bind(event.id, tenantId, runId, event.type, JSON.stringify(event.payload), nowMs()),
      ),
    ])

    // Best effort. The mutation committed; a queue that cannot be reached is not the caller's
    // problem, and the rows are on the table for the sweeper.
    try {
      await env.EVENTS.sendBatch(events.map((event) => ({ body: event })))
      await env.DB.prepare(`update outbox set dispatched_at = ? where id = ?`)
        .bind(nowMs(), events[0]?.id ?? '')
        .run()
    } catch {
      // deliberately ignored
    }

    return output
  } catch (error) {
    const outcome = await unwind()
    const message = error instanceof Error ? error.message : String(error)

    await env.DB.batch([
      env.DB.prepare(`update runs set status = ?, error = ?, finished_at = ? where id = ?`).bind(
        outcome,
        message,
        nowMs(),
        runId,
      ),
      env.DB.prepare(
        `insert into outbox (id, tenant_id, run_id, type, payload, occurred_at)
         values (?, ?, ?, 'booking.failed', ?, ?)`,
      ).bind(`${runId}:0`, tenantId, runId, JSON.stringify({ runId, outcome }), nowMs()),
    ])

    throw error
  }
}

declare function holdSeat(seat: string): Promise<{ id: string; price: number }>
declare function releaseSeat(id: string): Promise<void>
declare function chargeCard(card: string, amount: number): Promise<{ id: string }>
declare function refund(id: string): Promise<void>
declare function sendConfirmation(email: string, holdId: string): Promise<void>
