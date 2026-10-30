import type { PropertiesSnapshot } from './run-state'

// GitHub rejects comment bodies over 65,536 characters; leave headroom.
export const MAX_COMMENT_CHARS = 60_000
export const MAX_STATUS_DESCRIPTION_CHARS = 140
const MAX_CELL_CHARS = 120

export type CommentPhase =
  | 'launching'
  | 'running'
  | 'completed'
  | 'run_failed'
  | 'api_error'
  | 'timed_out'
  | 'aborted'

export interface CommentView {
  /** Identifies the comment to update; one per test per pull request. */
  marker_key: string
  title: string
  phase: CommentPhase
  run_id?: string
  run_url?: string
  commit_sha: string
  snapshot?: PropertiesSnapshot
  /** ISO-8601, rendered in UTC. */
  updated_at: string
  /** The run status for `run_failed`, or the error text for `api_error`. */
  status_label?: string
  reason?: string
  max_failures: number
  /** Human text for the footer, e.g. "about once a minute". */
  update_cadence?: string
  waited_label?: string
}

export function comment_marker(marker_key: string): string {
  return `<!-- antithesis-trigger-action:test=${encodeURIComponent(marker_key)} -->`
}

export function has_marker(
  body: string | null | undefined,
  marker_key: string
): boolean {
  return (body ?? '').startsWith(comment_marker(marker_key))
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return `${text.slice(0, max - 1)}…`
}

/** Make arbitrary text safe inside a GitHub markdown table cell. */
export function escape_cell(text: string): string {
  return truncate(
    text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim(),
    MAX_CELL_CHARS
  )
}

function format_time(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function heading(view: CommentView): string {
  const title = `## Antithesis · ${view.title.replace(/\s+/g, ' ').trim()}`
  switch (view.phase) {
    case 'launching':
      return `${title} — :hourglass_flowing_sand: Launching`
    case 'running':
      return `${title} — :hourglass_flowing_sand: Running`
    case 'completed':
      return `${title} — :white_check_mark: Completed`
    case 'run_failed':
      return `${title} — :warning: Did not complete (${view.status_label ?? 'unknown'})`
    case 'api_error':
      return `${title} — :warning: Results unavailable`
    case 'timed_out':
      return `${title} — :hourglass_flowing_sand: Still running`
    case 'aborted':
      return `${title} — :hourglass_flowing_sand: Running (workflow cancelled)`
  }
}

function counts_cell(snapshot: PropertiesSnapshot | undefined): string {
  if (snapshot === undefined) return '_waiting for the first results_'
  return [
    `:white_check_mark: ${snapshot.passing_count} passing`,
    `:x: ${snapshot.failing_count} failing`,
    `:white_circle: ${snapshot.undetermined_count} undetermined`
  ].join(' · ')
}

function footer(view: CommentView): string {
  switch (view.phase) {
    case 'launching':
    case 'running':
      return `<sub>Live results update as Antithesis reports them (${view.update_cadence ?? 'about once a minute'}). Failing properties do not fail this check.</sub>`
    case 'completed':
      return `<sub>Run completed at ${format_time(view.updated_at)}. Failing properties do not fail this check.</sub>`
    case 'run_failed':
      return `<sub>The run ended before it could finish testing; this check fails only for that reason.</sub>`
    case 'api_error':
      return `<sub>The run may still be in progress in Antithesis; open it for the current results.</sub>`
    case 'timed_out':
      return `<sub>This workflow stopped waiting${view.waited_label ? ` after ${view.waited_label}` : ''}; results keep updating in Antithesis.</sub>`
    case 'aborted':
      return `<sub>The workflow was cancelled; the Antithesis run continues.</sub>`
  }
}

function failing_section(view: CommentView, max_rows: number): string {
  const snapshot = view.snapshot
  if (snapshot === undefined || snapshot.failing_count === 0) return ''

  const rows = snapshot.failing.slice(0, max_rows)
  const overflow = snapshot.failing_count - rows.length
  const final = view.phase !== 'running' && view.phase !== 'launching'
  const open = final && snapshot.failing_count > 10 ? '' : ' open'
  const plural = snapshot.failing_count === 1 ? 'property' : 'properties'

  const lines = [
    `<details${open}>`,
    `<summary>:x: ${snapshot.failing_count} failing ${plural}</summary>`,
    '',
    '| Property | Group | Counterexamples |',
    '| --- | --- | --- |',
    ...rows.map(
      p =>
        `| \`${escape_cell(p.name)}\` | ${p.group ? escape_cell(p.group) : '—'} | ${p.counterexample_count ?? 0} |`
    )
  ]
  if (overflow > 0) {
    const link = view.run_url ? `[run](${view.run_url})` : 'run'
    lines.push('', `_…and ${overflow} more — see the ${link}._`)
  }
  lines.push('', '</details>')
  return lines.join('\n')
}

function render_with_rows(view: CommentView, max_rows: number): string {
  const run_cell = view.run_url
    ? `[View run in Antithesis](${view.run_url})${view.run_id ? ` · \`${view.run_id}\`` : ''}`
    : view.run_id
      ? `\`${view.run_id}\``
      : '_not launched_'

  const rows = [
    `| **Run** | ${run_cell} |`,
    `| **Commit** | \`${view.commit_sha.slice(0, 7)}\` |`,
    `| **Properties** | ${counts_cell(view.snapshot)} |`
  ]
  if (view.phase === 'run_failed' || view.phase === 'api_error') {
    rows.push(
      `| **Reason** | ${escape_cell(view.reason ?? 'No reason reported')} |`
    )
  }
  rows.push(`| **Updated** | ${format_time(view.updated_at)} |`)

  const parts = [
    comment_marker(view.marker_key),
    heading(view),
    '',
    '|  |  |',
    '| --- | --- |',
    ...rows,
    ''
  ]
  const failing = failing_section(view, max_rows)
  if (failing !== '') parts.push(failing, '')
  parts.push(footer(view))
  return parts.join('\n')
}

/** The pull request comment body for a view. Always starts with the marker. */
export function render_comment(view: CommentView): string {
  let max_rows = Math.max(1, view.max_failures)
  let body = render_with_rows(view, max_rows)
  // Shrink the table until the body fits GitHub's limit; the counts and the
  // link survive even if every row has to go.
  while (body.length > MAX_COMMENT_CHARS && max_rows > 0) {
    max_rows = Math.floor(max_rows / 2)
    body = render_with_rows(view, max_rows)
  }
  return body
}

/** The commit status description (GitHub caps it at 140 characters). */
export function render_status_description(view: CommentView): string {
  const s = view.snapshot
  let text: string
  switch (view.phase) {
    case 'launching':
      text = 'Antithesis run launched; waiting for results.'
      break
    case 'running':
      text = s
        ? `Antithesis is running: ${s.passing_count} passing, ${s.failing_count} failing, ${s.undetermined_count} undetermined.`
        : 'Antithesis is running your tests.'
      break
    case 'completed': {
      const total = s
        ? s.passing_count + s.failing_count + s.undetermined_count
        : 0
      text = s
        ? `Antithesis run completed: ${s.passing_count}/${total} properties passing (${s.failing_count} failing).`
        : 'Antithesis run completed.'
      break
    }
    case 'run_failed':
      text = `Antithesis run ended as ${view.status_label ?? 'unknown'}${view.reason ? `: ${view.reason}` : '.'}`
      break
    case 'api_error':
      text = 'Could not read Antithesis results; open the run for details.'
      break
    case 'timed_out':
      text = 'Antithesis is still running; this workflow stopped waiting.'
      break
    case 'aborted':
      text = 'Antithesis is still running; the workflow was cancelled.'
      break
  }
  return truncate(text.replace(/\s+/g, ' '), MAX_STATUS_DESCRIPTION_CHARS)
}
