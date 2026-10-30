import type { Property } from './snouty-client'

/** Run statuses after which nothing changes. `unknown` is terminal in practice: snouty cannot tell whether such a run will move again. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
  'incomplete',
  'unknown'
])

export function is_terminal(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status)
}

/** Code-point order: the same on every runner, unlike locale collation. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface PropertiesSnapshot {
  failing: Property[]
  passing_count: number
  failing_count: number
  undetermined_count: number
  /** Milliseconds since the epoch, from the watcher's clock. */
  fetched_at: number
}

/**
 * Combine the three filtered listings into one snapshot. Failing properties
 * are sorted by group then name so successive comments diff cleanly.
 */
export function snapshot_from_lists(
  failing: Property[],
  passing: Property[],
  undetermined: Property[],
  fetched_at: number
): PropertiesSnapshot {
  const sorted = [...failing].sort(
    (a, b) =>
      compare(a.group ?? '', b.group ?? '') ||
      compare(a.name, b.name) ||
      compare(a.id, b.id)
  )
  return {
    failing: sorted,
    passing_count: passing.length,
    failing_count: failing.length,
    undetermined_count: undetermined.length,
    fetched_at
  }
}
