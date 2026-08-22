import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { measure } from 'mitata'

import { footprints } from './footprint'
import { memorySubject, plainRun, sqliteSubject, stepCounts, type Subject } from './subjects'

/*
 * What sagaflow costs, measured rather than felt.
 *
 * Absolute numbers only, from one machine, stated with the machine attached. There are no
 * comparisons with other libraries here and there will not be: a number measured on this laptop
 * against a number somebody else measured on theirs is not a comparison, and publishing one
 * would be marketing wearing a lab coat.
 *
 * The comparison that IS here is the only one that survives leaving this machine: how much you
 * have to write to get the same guarantees three different ways. That is counted, not timed.
 */

const nsPerMs = 1e6
const minCpuTimeMs = Number(process.env.SAGAFLOW_BENCH_MS ?? 642)
const warmupRounds = Number(process.env.SAGAFLOW_BENCH_WARMUP ?? 2000)

type Percentiles = {
  samples: number
  min: number
  p50: number
  p75: number
  p95: number
  p99: number
  max: number
  avg: number
}

const percentile = (ascending: number[], fraction: number): number => {
  const rank = Math.ceil(fraction * ascending.length) - 1

  return ascending[Math.min(ascending.length - 1, Math.max(0, rank))] ?? 0
}

/*
 * Computed here rather than read off mitata's own stats, because p95 is not among the ones it
 * reports and a table whose columns come from two different definitions of "percentile" is
 * worse than one with a column missing.
 */
const percentilesOf = (samples: number[]): Percentiles => {
  const ascending = samples.toSorted((left, right) => left - right)

  return {
    samples: ascending.length,
    min: percentile(ascending, 0),
    p50: percentile(ascending, 0.5),
    p75: percentile(ascending, 0.75),
    p95: percentile(ascending, 0.95),
    p99: percentile(ascending, 0.99),
    max: percentile(ascending, 1),
    avg: ascending.reduce((total, sample) => total + sample, 0) / (ascending.length || 1),
  }
}

const warmUp = async (run: (steps: number) => Promise<unknown>, steps: number): Promise<void> => {
  for (let round = 0; round < warmupRounds; round += 1) await run(steps)
}

/**
 * One subject at one step count.
 *
 * `reset` runs as a mitata computed parameter, which is evaluated outside the timed region —
 * the memory journal reads its own arrays on every write, so a benchmark that let them grow
 * between samples would be measuring the fixture's arithmetic. `batch_threshold: 0` keeps
 * mitata from batching samples, which would run the resets in a block of their own and undo
 * exactly that.
 */
const measureSubject = async (
  before: () => void,
  run: (steps: number) => Promise<unknown>,
  steps: number,
): Promise<Percentiles> => {
  before()
  await warmUp(run, steps)

  const stats = await measure(
    function* () {
      yield {
        [0]() {
          before()

          return steps
        },
        async bench(count: number) {
          await run(count)
        },
      }
    },
    { batch_threshold: 0, min_cpu_time: minCpuTimeMs * nsPerMs },
  )

  return percentilesOf(stats.samples)
}

const nothing = (): void => undefined

const subjectsToMeasure = (): { journal: string; subject: Subject }[] => [
  { journal: 'plain', subject: { reset: nothing, run: (steps) => plainRun(steps) } },
  { journal: 'memory', subject: memorySubject() },
  { journal: 'sqlite', subject: sqliteSubject() },
]

const ns = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(2)} µs` : `${value.toFixed(0)} ns`

const main = async (): Promise<void> => {
  const packaged = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8'),
  ) as { version: string }

  const machine = {
    runtime: `bun ${Bun.version}`,
    arch: process.arch,
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    // Recorded because it is the single thing most likely to explain a figure that does not
    // match the committed one. A benchmark taken on a busy machine is not wrong, but it is not
    // comparable, and a reader can only know which by being told.
    loadAverage: os.loadavg().map((load) => Number(load.toFixed(2))),
  }

  console.info(
    `sagaflow ${packaged.version} · ${machine.runtime} · ${machine.cpu} · ${machine.arch}`,
  )
  console.info(
    `${minCpuTimeMs} ms of samples per subject, after ${warmupRounds} warm-up runs, no sink`,
  )
  console.info(`load average ${machine.loadAverage.join(' ')}\n`)

  const measurements: ({ journal: string; steps: number } & Percentiles)[] = []

  for (const { journal, subject } of subjectsToMeasure()) {
    for (const steps of stepCounts) {
      const measured = await measureSubject(
        () => subject.reset(),
        (count) => subject.run(count),
        steps,
      )
      measurements.push({ journal, steps, ...measured })

      console.info(
        `${journal.padEnd(7)} ${String(steps).padStart(2)} steps  ` +
          `p50 ${ns(measured.p50).padStart(9)}  ` +
          `p95 ${ns(measured.p95).padStart(9)}  ` +
          `p99 ${ns(measured.p99).padStart(9)}  ` +
          `(${measured.samples} samples)`,
      )
    }
  }

  /*
   * The marginal cost of a step, from the slope between the shortest and longest saga rather
   * than by dividing a run by its steps. Dividing would fold the fixed cost of opening and
   * closing a run into every step and quietly overstate what a step costs.
   */
  const derived = Object.fromEntries(
    [...new Set(measurements.map((measured) => measured.journal))].map((journal) => {
      const shortest = measurements.find((m) => m.journal === journal && m.steps === 1)
      const longest = measurements.find((m) => m.journal === journal && m.steps === 20)
      const perStep = ((longest?.p50 ?? 0) - (shortest?.p50 ?? 0)) / 19

      return [journal, { perStepNs: perStep, perRunFixedNs: (shortest?.p50 ?? 0) - perStep }]
    }),
  )

  console.info('')
  for (const [journal, { perStepNs, perRunFixedNs }] of Object.entries(derived)) {
    console.info(
      `${journal.padEnd(7)} ${ns(perRunFixedNs).padStart(9)} to open and close a run, ` +
        `${ns(perStepNs)} per step`,
    )
  }

  const written = footprints()
  console.info('')
  for (const footprint of written) {
    console.info(
      `${footprint.subject.padEnd(26)} ${String(footprint.code).padStart(4)} lines of code ` +
        `(${footprint.lines} including comments)`,
    )
  }

  const results = {
    version: packaged.version,
    measuredAt: new Date().toISOString(),
    machine,
    methodology: {
      unit: 'nanoseconds',
      clock: 'Bun.nanoseconds via mitata',
      minCpuTimeMs,
      warmupRounds,
      batching: 'disabled, so per-sample state is reset outside the timed region',
      sink: 'none configured, so no delivery is measured',
      sqlite: 'bun:sqlite at :memory: — real statements and real transactions, no disk',
    },
    measurements,
    derived,
    whatYouMustWrite: written,
  }

  const output = path.join(import.meta.dirname, 'results', `${packaged.version}.json`)
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`)
  console.info(`\nwritten to bench/results/${packaged.version}.json`)
}

await main()
