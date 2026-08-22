# The same booking, written three ways

One mutation: hold a seat, charge a card, send a confirmation. The first two can be undone, the
third cannot. It is asked for by a client that retries, so asking twice must book once.

Every version here delivers the **same guarantees**, because a comparison between a complete
implementation and a convenient one is not worth counting:

|                        |                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------- |
| A run record           | which mutation ran, when, for whom, with what input and what it answered           |
| A step trail           | which steps completed, in order, so a failure can be explained afterwards          |
| Compensation           | on failure, every completed step is undone in reverse, and the outcome is recorded |
| Idempotency            | one key per tenant, held by a run that is standing, released by one that failed    |
| A transactional outbox | the run closes and its event is queued in one write, or neither happens            |
| At-least-once delivery | the event is sent, and a row is left behind for a sweeper if it is not             |

`sagaflow.ts` is the whole thing. `hand-rolled.ts` and `cloudflare-workflows.ts` are what the
same six rows cost when you write them yourself — and neither of them yet has the sweepers, the
conformance-tested journal or the second executor.

`bun run bench` counts these files and writes the counts into `bench/results/`. Nothing here is
executed; it is measured with a line counter, which is why it is the one number in the whole
benchmark that is identical on every machine.
