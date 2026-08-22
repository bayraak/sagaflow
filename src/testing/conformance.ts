import { IdempotencyKeyHeldError } from '../errors.js'
import type { EventEnvelope, RunJournal, RunStatus } from '../types.js'
import { assertIs, assertRefuses, assertSame, assertThat } from './assert.js'

/**
 * A journal under test, plus the two readings a caller has to supply because the contract
 * itself has no way to make them: what status a run is in, and how many step rows a run has.
 * Both are one query in any store.
 */
export type JournalSubject = {
  journal: RunJournal
  runStatus: (params: { tenantId: string; runId: string }) => Promise<RunStatus | null>
  countSteps: (params: { tenantId: string; runId: string }) => Promise<number>
  /**
   * Make outbox writes fail from now on. Required, because the case it enables is the
   * strongest promise in the contract and an adapter that cannot be broken on purpose cannot
   * prove it. Dropping the table, revoking the permission or setting a flag are all fine.
   */
  breakOutboxWrites: () => Promise<void> | void
}

export type ConformanceCase = { name: string; run: () => Promise<void> }

const tenant = 'tenant_conformance'
const other = 'tenant_other'

const envelopeOf = (params: {
  id: string
  tenantId?: string
  occurredAt: number
  runId?: string
}): EventEnvelope => ({
  id: params.id,
  type: 'conformance.event',
  payload: { id: params.id },
  tenantId: params.tenantId ?? tenant,
  actor: null,
  runId: params.runId ?? null,
  occurredAt: params.occurredAt,
})

/**
 * The RunJournal contract, as an executable suite.
 *
 * The contract is not a shape — TypeScript already checks the shape — it is a set of promises
 * about behaviour that the engine relies on absolutely: that a held key is refused, that a
 * finish is one write, that a step row is written once however often it is retried. An adapter
 * that type-checks and breaks one of those breaks the engine in ways that only show up in
 * production, so every adapter proves itself against the same cases.
 *
 * Runner-agnostic on purpose. Wire it into whatever you use:
 *
 * ```ts
 * for (const c of journalConformance(createSubject)) it(c.name, c.run)
 * ```
 */
export const journalConformance = (
  createSubject: () => JournalSubject | Promise<JournalSubject>,
): ConformanceCase[] => {
  const withSubject = (
    name: string,
    body: (subject: JournalSubject) => Promise<void>,
  ): ConformanceCase => ({
    name,
    run: async (): Promise<void> => {
      await body(await createSubject())
    },
  })

  const openRun = (
    journal: RunJournal,
    params: {
      tenantId?: string
      idempotencyKey?: string | null
      execution?: 'durable' | 'inline'
    } = {},
  ): Promise<string> =>
    journal.insertRun({
      tenantId: params.tenantId ?? tenant,
      name: 'conformance.workflow',
      execution: params.execution ?? 'inline',
      idempotencyKey: params.idempotencyKey ?? null,
      input: { asked: true },
    })

  const closeRun = (
    journal: RunJournal,
    runId: string,
    status: RunStatus,
    output?: unknown,
  ): Promise<void> =>
    journal.finishRun({
      tenantId: tenant,
      runId,
      status: status === 'running' ? 'failed' : status,
      output,
    })

  return [
    withSubject('insertRun opens a run that is running', async ({ journal, runStatus }) => {
      const runId = await openRun(journal)

      assertThat(typeof runId === 'string' && runId.length > 0, 'insertRun must answer with an id')
      assertIs(await runStatus({ tenantId: tenant, runId }), 'running', 'a new run is running')
    }),

    withSubject('insertRun records the run a run was started from', async ({ journal }) => {
      const parent = await openRun(journal)
      const child = await journal.insertRun({
        tenantId: tenant,
        name: 'conformance.child',
        execution: 'inline',
        idempotencyKey: null,
        input: {},
        parentRunId: parent,
      })

      assertThat(child !== parent, 'a child run is its own run')
    }),

    withSubject('insertRun refuses a key a running run holds', async ({ journal }) => {
      await openRun(journal, { idempotencyKey: 'key-a' })

      await assertRefuses(
        () => openRun(journal, { idempotencyKey: 'key-a' }),
        'a key held by a running run must be refused',
      )
    }),

    // Named rather than merely thrown. Every store words a uniqueness violation differently,
    // and an engine that had to match on the wording would be wrong on the next store somebody
    // brings. A typed refusal lets it tell "this key is taken" apart from "the database is on
    // fire" — and tell them apart safely enough to retry the one that is worth retrying.
    withSubject('insertRun names its refusal', async ({ journal }) => {
      await openRun(journal, { idempotencyKey: 'key-named' })

      const thrown = await openRun(journal, { idempotencyKey: 'key-named' }).catch(
        (error: unknown) => error,
      )

      assertThat(
        thrown instanceof IdempotencyKeyHeldError,
        'a held key must be refused with IdempotencyKeyHeldError',
      )
      assertIs(
        (thrown as IdempotencyKeyHeldError).idempotencyKey,
        'key-named',
        'the refusal names the key',
      )
    }),

    withSubject('insertRun refuses a key a completed run holds', async ({ journal }) => {
      const runId = await openRun(journal, { idempotencyKey: 'key-b' })
      await closeRun(journal, runId, 'completed', { done: true })

      await assertRefuses(
        () => openRun(journal, { idempotencyKey: 'key-b' }),
        'a key held by a completed run must be refused',
      )
    }),

    ...(['failed', 'compensated', 'cancelled'] as const).map((status) =>
      withSubject(`insertRun accepts a key a ${status} run has released`, async ({ journal }) => {
        const runId = await openRun(journal, { idempotencyKey: `key-${status}` })
        await closeRun(journal, runId, status)

        const second = await openRun(journal, { idempotencyKey: `key-${status}` })

        assertThat(second !== runId, `a ${status} run must release its key`)
      }),
    ),

    withSubject('insertRun allows one key per tenant', async ({ journal }) => {
      await openRun(journal, { idempotencyKey: 'shared' })
      const elsewhere = await openRun(journal, { idempotencyKey: 'shared', tenantId: other })

      assertThat(elsewhere.length > 0, 'another tenant may hold the same key')
    }),

    withSubject('insertRun allows any number of runs with no key', async ({ journal }) => {
      const first = await openRun(journal, { idempotencyKey: null })
      const second = await openRun(journal, { idempotencyKey: null })

      assertThat(first !== second, 'runs without a key never collide')
    }),

    withSubject('findRunByIdempotencyKey answers with the held run', async ({ journal }) => {
      const runId = await openRun(journal, { idempotencyKey: 'key-c' })
      await closeRun(journal, runId, 'completed', { invoice: 7 })

      const found = await journal.findRunByIdempotencyKey({
        tenantId: tenant,
        idempotencyKey: 'key-c',
      })

      assertIs(found?.id, runId, 'the held run is the one that claimed the key')
      assertIs(found?.status, 'completed', 'the held run reports its status')
      assertSame(found?.output, { invoice: 7 }, 'the held run reports its output')
    }),

    withSubject(
      'findRunByIdempotencyKey answers with nothing once released',
      async ({ journal }) => {
        const runId = await openRun(journal, { idempotencyKey: 'key-d' })
        await closeRun(journal, runId, 'compensated')

        assertIs(
          await journal.findRunByIdempotencyKey({ tenantId: tenant, idempotencyKey: 'key-d' }),
          null,
          'a released key is held by nobody',
        )
      },
    ),

    withSubject(
      'findRunByIdempotencyKey answers with nothing for an unknown key',
      async ({ journal }) => {
        assertIs(
          await journal.findRunByIdempotencyKey({ tenantId: tenant, idempotencyKey: 'nothing' }),
          null,
          'an unclaimed key is held by nobody',
        )
      },
    ),

    withSubject('recordStep writes one row per attempt', async ({ journal, countSteps }) => {
      const runId = await openRun(journal)

      for (const attempt of [1, 2]) {
        await journal.recordStep({
          tenantId: tenant,
          runId,
          seq: 0,
          name: 'charge',
          status: 'failed',
          attempt,
          error: 'refused',
        })
      }

      assertIs(await countSteps({ tenantId: tenant, runId }), 2, 'each attempt is its own row')
    }),

    withSubject(
      'recordStep is idempotent on run, seq and attempt',
      async ({ journal, countSteps }) => {
        const runId = await openRun(journal)

        for (let write = 0; write < 3; write += 1) {
          await journal.recordStep({
            tenantId: tenant,
            runId,
            seq: 0,
            name: 'charge',
            status: 'completed',
            attempt: 1,
            output: { chargeId: 'ch_1' },
          })
        }

        assertIs(await countSteps({ tenantId: tenant, runId }), 1, 'the same attempt is one row')
      },
    ),

    withSubject('recordStep reports no cancellation by default', async ({ journal }) => {
      const runId = await openRun(journal)

      const recorded = await journal.recordStep({
        tenantId: tenant,
        runId,
        seq: 0,
        name: 'charge',
        status: 'completed',
        attempt: 1,
      })

      assertIs(recorded.cancellationRequested, false, 'nobody asked this run to stop')
    }),

    withSubject('recordStep reports a cancellation in the same round trip', async ({ journal }) => {
      const runId = await openRun(journal)
      await journal.requestCancellation({ tenantId: tenant, runId })

      const recorded = await journal.recordStep({
        tenantId: tenant,
        runId,
        seq: 0,
        name: 'charge',
        status: 'completed',
        attempt: 1,
      })

      assertIs(recorded.cancellationRequested, true, 'the flag comes back with the step')
    }),

    withSubject('requestCancellation is accepted by a running run', async ({ journal }) => {
      const runId = await openRun(journal)

      assertIs(
        await journal.requestCancellation({ tenantId: tenant, runId }),
        true,
        'a running run can be asked to stop',
      )
    }),

    withSubject('requestCancellation is refused by a finished run', async ({ journal }) => {
      const runId = await openRun(journal)
      await closeRun(journal, runId, 'completed')

      assertIs(
        await journal.requestCancellation({ tenantId: tenant, runId }),
        false,
        'a finished run cannot be stopped',
      )
    }),

    withSubject('requestCancellation is refused for another tenant', async ({ journal }) => {
      const runId = await openRun(journal)

      assertIs(
        await journal.requestCancellation({ tenantId: other, runId }),
        false,
        'a run belongs to one tenant',
      )
    }),

    withSubject('requestCancellation is refused for an unknown run', async ({ journal }) => {
      assertIs(
        await journal.requestCancellation({ tenantId: tenant, runId: 'run_nowhere' }),
        false,
        'a run nobody has heard of cannot be stopped',
      )
    }),

    withSubject('finishRun closes the run', async ({ journal, runStatus }) => {
      const runId = await openRun(journal)
      await closeRun(journal, runId, 'completed', { done: true })

      assertIs(await runStatus({ tenantId: tenant, runId }), 'completed', 'the run is closed')
    }),

    withSubject('finishRun writes the events it carries', async ({ journal }) => {
      const runId = await openRun(journal)
      await journal.finishRun({
        tenantId: tenant,
        runId,
        status: 'completed',
        events: [envelopeOf({ id: `${runId}:0`, occurredAt: 10, runId })],
      })

      const stranded = await journal.listUndispatchedEvents({ before: 1000, limit: 10 })

      assertSame(
        stranded.map((row) => row.envelope.id),
        [`${runId}:0`],
        'the finish queues the events it was given',
      )
    }),

    withSubject(
      'finishRun is safe to call twice with the same arguments',
      async ({ journal, runStatus }) => {
        const runId = await openRun(journal)
        const events = [envelopeOf({ id: `${runId}:0`, occurredAt: 10, runId })]

        await journal.finishRun({ tenantId: tenant, runId, status: 'completed', events })
        await journal.finishRun({ tenantId: tenant, runId, status: 'completed', events })

        const stranded = await journal.listUndispatchedEvents({ before: 1000, limit: 10 })

        assertIs(stranded.length, 1, 'an outbox row is written once per envelope id')
        assertIs(
          await runStatus({ tenantId: tenant, runId }),
          'completed',
          'the run is still closed',
        )
      },
    ),

    /*
     * A zombie must not come back and take a key somebody else now holds.
     *
     * The sequence is real: a sweeper closes an abandoned inline run, which releases its key; a
     * caller asks for the work again and the new run takes the key; then the first run turns
     * out not to have been dead after all and finishes. Its finish would re-enter the held set
     * under a key that is taken — a uniqueness violation thrown from inside a step, retried,
     * and finally an instance in error over a run nobody was waiting for. Whoever closed the
     * run first decided how it ended.
     */
    withSubject(
      'finishRun does not reopen a run somebody else already closed',
      async ({ journal, runStatus }) => {
        const abandoned = await openRun(journal, { idempotencyKey: 'key-zombie' })
        await closeRun(journal, abandoned, 'failed')
        const replacement = await openRun(journal, { idempotencyKey: 'key-zombie' })

        await journal.finishRun({
          tenantId: tenant,
          runId: abandoned,
          status: 'completed',
          output: { late: true },
        })

        assertIs(
          await runStatus({ tenantId: tenant, runId: abandoned }),
          'failed',
          'a run that was already closed keeps the ending it was given',
        )
        assertIs(
          (
            await journal.findRunByIdempotencyKey({
              tenantId: tenant,
              idempotencyKey: 'key-zombie',
            })
          )?.id,
          replacement,
          'the key stays with the run that holds it',
        )
      },
    ),

    withSubject('markEventsDispatched takes them out of the sweep', async ({ journal }) => {
      const runId = await openRun(journal)
      await journal.finishRun({
        tenantId: tenant,
        runId,
        status: 'completed',
        events: [
          envelopeOf({ id: `${runId}:0`, occurredAt: 10, runId }),
          envelopeOf({ id: `${runId}:1`, occurredAt: 20, runId }),
        ],
      })

      await journal.markEventsDispatched({ tenantId: tenant, ids: [`${runId}:0`] })
      const stranded = await journal.listUndispatchedEvents({ before: 1000, limit: 10 })

      assertSame(
        stranded.map((row) => row.envelope.id),
        [`${runId}:1`],
        'a stamped row is not swept again',
      )
    }),

    withSubject('listUndispatchedEvents answers oldest first', async ({ journal }) => {
      const runId = await openRun(journal)
      await journal.finishRun({
        tenantId: tenant,
        runId,
        status: 'completed',
        events: [
          envelopeOf({ id: `${runId}:1`, occurredAt: 300, runId }),
          envelopeOf({ id: `${runId}:0`, occurredAt: 100, runId }),
        ],
      })

      const stranded = await journal.listUndispatchedEvents({ before: 1000, limit: 10 })

      assertSame(
        stranded.map((row) => row.envelope.id),
        [`${runId}:0`, `${runId}:1`],
        'the sweep starts with the oldest',
      )
    }),

    withSubject('listUndispatchedEvents honours the cutoff', async ({ journal }) => {
      const runId = await openRun(journal)
      await journal.finishRun({
        tenantId: tenant,
        runId,
        status: 'completed',
        events: [
          envelopeOf({ id: `${runId}:0`, occurredAt: 100, runId }),
          envelopeOf({ id: `${runId}:1`, occurredAt: 900, runId }),
        ],
      })

      const stranded = await journal.listUndispatchedEvents({ before: 500, limit: 10 })

      assertSame(
        stranded.map((row) => row.envelope.id),
        [`${runId}:0`],
        'a row younger than the cutoff is left alone',
      )
    }),

    withSubject('listUndispatchedEvents honours the limit', async ({ journal }) => {
      const runId = await openRun(journal)
      await journal.finishRun({
        tenantId: tenant,
        runId,
        status: 'completed',
        events: [0, 1, 2].map((ordinal) =>
          envelopeOf({ id: `${runId}:${ordinal}`, occurredAt: 100 + ordinal, runId }),
        ),
      })

      const stranded = await journal.listUndispatchedEvents({ before: 1000, limit: 2 })

      assertIs(stranded.length, 2, 'a sweep takes no more than it asked for')
    }),

    withSubject('listUndispatchedEvents crosses every tenant', async ({ journal }) => {
      const mine = await openRun(journal)
      const theirs = await openRun(journal, { tenantId: other })

      await journal.finishRun({
        tenantId: tenant,
        runId: mine,
        status: 'completed',
        events: [envelopeOf({ id: `${mine}:0`, occurredAt: 100, runId: mine })],
      })
      await journal.finishRun({
        tenantId: other,
        runId: theirs,
        status: 'completed',
        events: [
          envelopeOf({ id: `${theirs}:0`, occurredAt: 200, tenantId: other, runId: theirs }),
        ],
      })

      const stranded = await journal.listUndispatchedEvents({ before: 1000, limit: 10 })

      assertSame(
        stranded.map((row) => row.tenantId),
        [tenant, other],
        'the sweep reads for everybody',
      )
    }),

    withSubject(
      'listAbandonedRuns answers with inline runs older than the cutoff',
      async ({ journal }) => {
        const runId = await openRun(journal, { execution: 'inline' })

        const abandoned = await journal.listAbandonedRuns({
          execution: 'inline',
          startedBefore: Date.now() + 60_000,
          limit: 10,
        })

        assertSame(
          abandoned,
          [{ tenantId: tenant, runId, name: 'conformance.workflow' }],
          'an abandoned run is answered with its tenant and its name, because closing it announces it',
        )
      },
    ),

    withSubject('listAbandonedRuns leaves younger inline runs alone', async ({ journal }) => {
      await openRun(journal, { execution: 'inline' })

      assertIs(
        (
          await journal.listAbandonedRuns({
            execution: 'inline',
            startedBefore: Date.now() - 60_000,
            limit: 10,
          })
        ).length,
        0,
        'nothing was old enough',
      )
    }),

    withSubject('listAbandonedRuns never answers with a durable run', async ({ journal }) => {
      await openRun(journal, { execution: 'durable' })

      assertIs(
        (
          await journal.listAbandonedRuns({
            execution: 'inline',
            startedBefore: Date.now() + 60_000,
            limit: 10,
          })
        ).length,
        0,
        'a durable run may sleep for a week',
      )
    }),

    withSubject('listAbandonedRuns never answers with a run that ended', async ({ journal }) => {
      const runId = await openRun(journal, { execution: 'inline' })
      await closeRun(journal, runId, 'completed')

      assertIs(
        (
          await journal.listAbandonedRuns({
            execution: 'inline',
            startedBefore: Date.now() + 60_000,
            limit: 10,
          })
        ).length,
        0,
        'a closed run needs nobody to close it',
      )
    }),

    withSubject('listAbandonedRuns honours the limit', async ({ journal }) => {
      for (let opened = 0; opened < 3; opened += 1) await openRun(journal, { execution: 'inline' })

      assertIs(
        (
          await journal.listAbandonedRuns({
            execution: 'inline',
            startedBefore: Date.now() + 60_000,
            limit: 2,
          })
        ).length,
        2,
        'a sweep takes no more than it asked for',
      )
    }),

    // Closing an abandoned run releases its key like any other ending, so the work can be asked
    // for again.
    withSubject('a swept run releases its key', async ({ journal }) => {
      const runId = await openRun(journal, { execution: 'inline', idempotencyKey: 'key-swept' })
      await closeRun(journal, runId, 'failed')

      const second = await openRun(journal, { execution: 'inline', idempotencyKey: 'key-swept' })

      assertThat(second !== runId, 'work whose run was abandoned can be asked for again')
    }),

    // The strongest promise in the contract, and the only one that needs the store to be
    // broken on purpose: a run is completed IF AND ONLY IF its events are queued. A journal
    // that writes the two separately can be interrupted between them, and "completed, audit
    // trail lost" is exactly the state that must not exist.
    withSubject('finishRun closes nothing when its events cannot be written', async (subject) => {
      const { journal, runStatus } = subject
      const runId = await openRun(journal)
      await subject.breakOutboxWrites()

      await assertRefuses(
        () =>
          journal.finishRun({
            tenantId: tenant,
            runId,
            status: 'completed',
            events: [envelopeOf({ id: `${runId}:0`, occurredAt: 10, runId })],
          }),
        'a finish that cannot write its events must fail',
      )

      assertIs(
        await runStatus({ tenantId: tenant, runId }),
        'running',
        'the run must be left running, for somebody to finish',
      )
    }),
  ]
}
