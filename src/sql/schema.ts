/*
 * The schema, and the single source of it.
 *
 * A TypeScript module rather than a file on disk, because `migrate()` has to be able to run it
 * in a Worker, where there is no file system to read. `schema.sql` is written from this and
 * shipped beside it for whoever's migration tool wants a file — and a test asserts the two have
 * not drifted, because a schema that exists twice eventually exists differently.
 */
export const schemaSql = `-- sagaflow reference schema (SQLite / Cloudflare D1).
--
-- GENERATED from src/sql/schema.ts by \`bun run schema\`. Edit that file, not this one.
--
-- Three tables. Your migration tool owns them, not sagaflow — copy this into a migration and
-- change what you like. If you rename a table, pass the new name through the \`tables\` option of
-- createSqlJournal so the engine and your schema agree.

create table if not exists saga_runs (
  id text primary key,
  tenant_id text not null,
  name text not null,
  -- 'inline' | 'durable'
  execution text not null,
  -- 'running' | 'completed' | 'compensated' | 'failed' | 'cancelled'
  status text not null,
  idempotency_key text,
  -- The run this one was started to do again, when it is one.
  replay_of text,
  -- The run this one was started from, when a step started it. Provenance only.
  parent_run_id text,
  input text not null,
  output text,
  error text,
  -- Raised by requestCancellation and read back by the engine at the next step boundary.
  cancel_requested integer not null default 0,
  started_at integer not null,
  finished_at integer
);

-- The key is claimed by a run that is still standing. A run that failed, compensated or was
-- cancelled RELEASES it, so the work can be asked for again — which is why this index is
-- PARTIAL. A plain unique index here would lock the door behind every failure.
create unique index if not exists saga_runs_held_key
  on saga_runs (tenant_id, idempotency_key)
  where status in ('running', 'completed');

create index if not exists saga_runs_tenant_started on saga_runs (tenant_id, started_at);
create index if not exists saga_runs_tenant_name on saga_runs (tenant_id, name);
-- The abandoned sweep's whole question.
create index if not exists saga_runs_open on saga_runs (status, execution, started_at);

create table if not exists saga_run_steps (
  id text primary key,
  tenant_id text not null,
  run_id text not null references saga_runs (id) on delete cascade,
  seq integer not null,
  name text not null,
  -- 'completed' | 'failed' | 'compensated'
  status text not null,
  attempt integer not null,
  output text,
  error text,
  recorded_at integer not null
);

-- What makes recordStep idempotent: the same attempt of the same step is one row, however many
-- times it is written.
create unique index if not exists saga_run_steps_attempt
  on saga_run_steps (run_id, seq, attempt);

create index if not exists saga_run_steps_run on saga_run_steps (run_id, seq);

-- Where a run's events are written, in the same atomic batch that closes the run. A run is
-- completed IF AND ONLY IF its events are here waiting. Delivery is a separate, later act.
create table if not exists saga_outbox (
  -- The envelope's own id, so the row and the message a consumer receives are the same thing
  -- named once, and a second write of the same run's events lands on rows that already exist.
  id text primary key,
  tenant_id text not null,
  run_id text,
  type text not null,
  -- The whole envelope as it will travel, so a sweep sends exactly what the run emitted rather
  -- than rebuilding it from columns years later.
  payload text not null,
  created_at integer not null,
  -- Null until the message has been handed to the sink. The sweeper's whole question.
  dispatched_at integer
);

create index if not exists saga_outbox_undispatched on saga_outbox (dispatched_at, created_at);
create index if not exists saga_outbox_tenant_created on saga_outbox (tenant_id, created_at);
`

/**
 * The same schema, one statement at a time, with comments removed — what `migrate()` executes
 * and what the `--format sql` bin prints when you ask for statements.
 */
export const schemaStatements: readonly string[] = schemaSql
  .replaceAll(/^\s*--.*$/gm, '')
  .split(';')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0)

/** What the three tables are called when nobody says otherwise. */
export const defaultTableNames = {
  runs: 'saga_runs',
  steps: 'saga_run_steps',
  outbox: 'saga_outbox',
} as const

/**
 * The same schema with the table names replaced. `createSqlJournal` lets a caller rename the
 * three tables, and the DDL has to follow or `migrate()` would create tables the journal never
 * writes to.
 */
export const schemaFor = (tables: {
  runs: string
  steps: string
  outbox: string
}): readonly string[] =>
  schemaStatements.map((statement) =>
    statement
      .replaceAll('saga_run_steps', tables.steps)
      .replaceAll('saga_runs', tables.runs)
      .replaceAll('saga_outbox', tables.outbox),
  )
