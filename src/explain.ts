import type { RunJournal } from './types.js'

export type ExplainFormat = 'mermaid' | 'text'

const statusMark: Record<string, string> = {
  completed: '✓',
  compensated: '↩',
  failed: '✗',
}

const duration = (from: number, to: number | null): string => (to === null ? '—' : `${to - from}ms`)

const asText = (
  run: {
    id: string
    name: string
    execution: string
    status: string
    error: string | null
    parentRunId: string | null
    replayOf: string | null
    startedAt: number
    finishedAt: number | null
  },
  steps: { seq: number; name: string; status: string; attempt: number; error: string | null }[],
): string => {
  const lines = [
    `${run.name} · ${run.id}`,
    `${run.execution} · ${run.status} · ${duration(run.startedAt, run.finishedAt)}`,
  ]

  if (run.parentRunId) lines.push(`started by ${run.parentRunId}`)
  if (run.replayOf) lines.push(`replay of ${run.replayOf}`)
  lines.push('')

  for (const step of steps) {
    const attempt = step.attempt > 1 ? ` (attempt ${step.attempt})` : ''
    const because = step.error === null ? '' : ` — ${step.error}`
    lines.push(`  ${statusMark[step.status] ?? '·'} ${step.name}${attempt}${because}`)
  }

  if (steps.length === 0) lines.push('  (no steps ran)')
  if (run.error !== null) lines.push('', `failed: ${run.error}`)

  return lines.join('\n')
}

const safe = (value: string): string => value.replaceAll(/["\n]/g, ' ')

const asMermaid = (
  run: { id: string; name: string; status: string },
  steps: { seq: number; name: string; status: string; error: string | null }[],
): string => {
  const lines = ['```mermaid', 'flowchart TD', `  run["${safe(run.name)}<br/>${run.status}"]`]
  let previous = 'run'

  for (const step of steps) {
    const id = `s${step.seq}`
    const because = step.error === null ? '' : `<br/>${safe(step.error)}`
    lines.push(`  ${id}["${statusMark[step.status] ?? '·'} ${safe(step.name)}${because}"]`)
    lines.push(`  ${previous} --> ${id}`)
    previous = id
  }

  return `${lines.join('\n')}\n\`\`\``
}

/**
 * A run, arranged so a person can read it.
 *
 * The run record is rows, which is right for a database and wrong for somebody at three in the
 * morning trying to work out what happened. This is the same rows in the order they happened,
 * with what failed and what was undone said out loud — as text for a terminal or a log line, or
 * as mermaid for an issue, a pull request or a runbook.
 */
export const explainRun = async (options: {
  journal: RunJournal
  tenantId: string
  runId: string
  format?: ExplainFormat
}): Promise<string> => {
  const { journal, tenantId, runId } = options

  if (!journal.getRun || !journal.listRunSteps) {
    return `this journal cannot read a run back: implement getRun and listRunSteps to explain ${runId}`
  }

  const run = await journal.getRun({ tenantId, runId })
  if (!run) return `no run ${runId} in ${tenantId}`

  const steps = await journal.listRunSteps({ tenantId, runId })

  return options.format === 'mermaid' ? asMermaid(run, steps) : asText(run, steps)
}
