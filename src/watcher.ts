import {
  render_comment,
  render_status_description,
  type CommentPhase,
  type CommentView
} from './comment-render'
import type { Reporter } from './github-reporter'
import {
  is_terminal,
  snapshot_from_lists,
  type PropertiesSnapshot
} from './run-state'
import {
  ApiError,
  type Property,
  type PropertyStatus,
  type RunDetail,
  type StreamEvent
} from './snouty-client'

// ==============================================================================
// Types
// ==============================================================================

export interface WatchClient {
  get_run(run_id: string): Promise<RunDetail>
  list_properties(run_id: string, status?: PropertyStatus): Promise<Property[]>
  open_stream(run_id: string, signal: AbortSignal): AsyncIterable<StreamEvent>
}

export interface WatchDeps {
  client: WatchClient
  reporter: Reporter
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  /** Aborted when the job is cancelled. */
  signal: AbortSignal
  log: { info(message: string): void; warning(message: string): void }
}

export interface WatchOptions {
  run_id: string
  run_url: string
  /** Everything the comment needs besides phase, snapshot and time. */
  view: Pick<
    CommentView,
    'marker_key' | 'title' | 'commit_sha' | 'max_failures'
  >
  poll_interval_ms: number
  update_interval_ms: number
  /** 0 means no deadline of the action's own. */
  wait_timeout_ms: number
  /** How many ticks a run may still look non-terminal after the stream said `completed`. */
  finalize_grace_ticks?: number
  limits?: Partial<typeof DEFAULT_LIMITS>
}

export const DEFAULT_LIMITS = {
  /** 404s tolerated before the run has ever been seen (propagation after launch). */
  not_found_before_seen: 10,
  /** 404s tolerated once the run was seen (it should not disappear). */
  not_found_after_seen: 5,
  /** Other consecutive status-poll failures before giving up. */
  consecutive_errors: 20,
  /** Longest backoff between status polls after failures. */
  max_backoff_ms: 5 * 60_000,
  /** Longest wait between stream reconnects. */
  stream_max_backoff_ms: 60_000,
  /** Give up on the stream after this long without a single event. */
  stream_fail_budget_ms: 10 * 60_000,
  /** Refresh the properties at least this often even without a stream event. */
  safety_refresh_ticks: 4,
  /** Refresh the pending commit status with live counts this often. */
  status_refresh_ms: 5 * 60_000
}

export type WatchOutcome =
  | { kind: 'completed'; snapshot?: PropertiesSnapshot }
  | {
      kind: 'run_failed'
      status: string
      failure_reason?: string
      snapshot?: PropertiesSnapshot
    }
  | { kind: 'api_error'; message: string; snapshot?: PropertiesSnapshot }
  | { kind: 'timed_out'; snapshot?: PropertiesSnapshot }
  | { kind: 'aborted'; snapshot?: PropertiesSnapshot }

type StreamState = 'connecting' | 'open' | 'disabled' | 'finalized'

interface State {
  started_at: number
  run?: RunDetail
  seen: boolean
  not_found_count: number
  error_count: number
  snapshot?: PropertiesSnapshot
  /** Something changed (or we never loaded); the next eligible tick refreshes. */
  dirty: boolean
  last_refresh_at: number
  last_status_refresh_at: number
  tick: number
  stream: StreamState
  /** The stream said the run is final; confirm with a status poll. */
  finalize_requested: boolean
  grace_ticks_used: number
  terminal?: WatchOutcome
  /** Wakes the main loop out of its sleep early. */
  wake: AbortController
}

// ==============================================================================
// The watcher
// ==============================================================================

/**
 * Follow a run until it is final (or the deadline / the job's cancellation
 * arrives), keeping the pull request comment and the commit status current.
 *
 * Three cooperating pieces:
 * - the status poll (`get_run`) is the heartbeat and the authority on whether
 *   the run is finished;
 * - the stream supervisor only marks state dirty when snouty reports property
 *   events, so a resync happens promptly without any merge logic;
 * - the refresh lists the properties and rewrites the comment, debounced.
 */
export async function watch_run(
  deps: WatchDeps,
  opts: WatchOptions
): Promise<WatchOutcome> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits }
  const state: State = {
    started_at: deps.now(),
    seen: false,
    not_found_count: 0,
    error_count: 0,
    dirty: true,
    last_refresh_at: Number.NEGATIVE_INFINITY,
    last_status_refresh_at: deps.now(),
    tick: 0,
    stream: 'connecting',
    finalize_requested: false,
    grace_ticks_used: 0,
    wake: new AbortController()
  }

  // The stream child must die with the watcher, not with the job: a quiet
  // stream would otherwise keep `finish` waiting forever.
  const stream_abort = new AbortController()
  const abort_stream = (): void => stream_abort.abort()
  deps.signal.addEventListener('abort', abort_stream, { once: true })
  const stream_task = supervise_stream(
    { ...deps, signal: any_signal([deps.signal, stream_abort.signal]) },
    opts,
    limits,
    state
  )

  try {
    for (;;) {
      state.tick += 1
      if (deps.signal.aborted) {
        return await finish(deps, opts, state, { kind: 'aborted' })
      }
      if (
        opts.wait_timeout_ms > 0 &&
        deps.now() - state.started_at >= opts.wait_timeout_ms
      ) {
        return await finish(deps, opts, state, { kind: 'timed_out' })
      }

      const delay = await poll_status(deps, opts, limits, state)
      if (state.terminal !== undefined) {
        return await finish(deps, opts, state, state.terminal)
      }

      if (should_refresh(opts, limits, state, deps.now())) {
        await refresh(deps, opts, state)
        if (state.snapshot !== undefined) {
          await deps.reporter.upsert_comment(
            render_comment(view_for(opts, state, 'running', deps.now()))
          )
        }
      }
      await refresh_pending_status(deps, opts, limits, state)

      state.wake = new AbortController()
      await deps.sleep(delay, any_signal([deps.signal, state.wake.signal]))
    }
  } finally {
    // Stop the stream child if it is still running.
    state.stream = 'finalized'
    state.wake.abort()
    stream_abort.abort()
    deps.signal.removeEventListener('abort', abort_stream)
    await stream_task
  }
}

// ------------------------------------------------------------------------------
// A. Status poll
// ------------------------------------------------------------------------------

/** Poll once; return how long to sleep before the next tick. */
async function poll_status(
  deps: WatchDeps,
  opts: WatchOptions,
  limits: typeof DEFAULT_LIMITS,
  state: State
): Promise<number> {
  try {
    state.run = await deps.client.get_run(opts.run_id)
    state.seen = true
    state.not_found_count = 0
    state.error_count = 0
  } catch (error) {
    const api_error =
      error instanceof ApiError
        ? error
        : new ApiError(
            error instanceof Error ? error.message : String(error),
            'other'
          )
    if (api_error.code === 'not_found') {
      state.not_found_count += 1
      const limit = state.seen
        ? limits.not_found_after_seen
        : limits.not_found_before_seen
      if (state.not_found_count > limit) {
        state.terminal = {
          kind: 'api_error',
          message: state.seen
            ? `the run disappeared from the API (${api_error.message})`
            : `the run never became visible in the API (${api_error.message})`,
          snapshot: state.snapshot
        }
      } else {
        deps.log.info(
          `Run ${opts.run_id} not visible yet (${state.not_found_count}/${limit}); retrying.`
        )
      }
      return opts.poll_interval_ms
    }
    if (api_error.code === 'unauthorized') {
      state.terminal = {
        kind: 'api_error',
        message: `Antithesis rejected the credentials: ${api_error.message}`,
        snapshot: state.snapshot
      }
      return opts.poll_interval_ms
    }
    state.error_count += 1
    if (state.error_count > limits.consecutive_errors) {
      state.terminal = {
        kind: 'api_error',
        message: `the run status could not be read ${state.error_count} times in a row: ${api_error.message}`,
        snapshot: state.snapshot
      }
      return opts.poll_interval_ms
    }
    deps.log.warning(
      `Could not read the run status (${state.error_count}/${limits.consecutive_errors}): ${api_error.message}`
    )
    return Math.min(
      opts.poll_interval_ms * 2 ** state.error_count,
      limits.max_backoff_ms
    )
  }

  const status = state.run.status
  if (is_terminal(status)) {
    state.terminal =
      status === 'completed'
        ? { kind: 'completed' }
        : {
            kind: 'run_failed',
            status,
            failure_reason: state.run.failure_reason ?? undefined
          }
  } else if (state.finalize_requested) {
    // The stream said the run is final but the status has not caught up.
    state.grace_ticks_used += 1
    if (state.grace_ticks_used > (opts.finalize_grace_ticks ?? 10)) {
      state.terminal = {
        kind: 'run_failed',
        status: 'unknown',
        failure_reason:
          'the stream reported the run as final but its status never did'
      }
    }
  }
  return opts.poll_interval_ms
}

// ------------------------------------------------------------------------------
// B. Stream supervisor
// ------------------------------------------------------------------------------

async function supervise_stream(
  deps: WatchDeps,
  opts: WatchOptions,
  limits: typeof DEFAULT_LIMITS,
  state: State
): Promise<void> {
  let backoff_ms = 1000
  let last_event_at = deps.now()

  while (
    !deps.signal.aborted &&
    state.stream !== 'disabled' &&
    state.stream !== 'finalized' &&
    !state.finalize_requested
  ) {
    try {
      for await (const event of deps.client.open_stream(
        opts.run_id,
        deps.signal
      )) {
        last_event_at = deps.now()
        backoff_ms = 1000
        if (event.event === 'open') {
          state.stream = 'open'
          deps.log.info('Property stream open; reading the current results.')
        } else if (event.event === 'completed') {
          request_finalize(state)
          return
        }
        // Any event, including `open`, means the listing may be stale.
        mark_dirty(state)
      }
      // snouty exits 0 only after `completed`; treat a clean exit the same.
      request_finalize(state)
      return
    } catch (error) {
      // The main loop may have finished while the stream was failing.
      if (deps.signal.aborted || is_finalized(state)) return
      const api_error =
        error instanceof ApiError
          ? error
          : new ApiError(
              error instanceof Error ? error.message : String(error),
              'other'
            )
      if (
        api_error.code === 'unsupported' ||
        api_error.code === 'unauthorized'
      ) {
        deps.log.info(
          `Property stream unavailable (${api_error.message}); polling instead.`
        )
        state.stream = 'disabled'
        mark_dirty(state)
        return
      }
      if (api_error.code === 'finished') {
        request_finalize(state)
        return
      }
      mark_dirty(state)
      if (deps.now() - last_event_at >= limits.stream_fail_budget_ms) {
        deps.log.warning(
          `Property stream kept failing (${api_error.message}); polling instead.`
        )
        state.stream = 'disabled'
        return
      }
      deps.log.info(
        `Property stream ended (${api_error.message}); reconnecting in ${backoff_ms / 1000}s.`
      )
      await deps.sleep(backoff_ms, deps.signal)
      backoff_ms = Math.min(backoff_ms * 2, limits.stream_max_backoff_ms)
    }
  }
}

function mark_dirty(state: State): void {
  state.dirty = true
}

/** Read through a function so TypeScript does not narrow a field another task mutates. */
function is_finalized(state: State): boolean {
  return state.stream === 'finalized'
}

function request_finalize(state: State): void {
  state.finalize_requested = true
  state.dirty = true
  state.wake.abort()
}

// ------------------------------------------------------------------------------
// C/D. Properties refresh and comment update
// ------------------------------------------------------------------------------

/**
 * Refresh when the listing may be stale and the debounce window has passed.
 * Without a working stream every tick counts as dirty; with one, a periodic
 * safety refresh guards against a missed event.
 */
function should_refresh(
  opts: WatchOptions,
  limits: typeof DEFAULT_LIMITS,
  state: State,
  now: number
): boolean {
  // Before the simulation session exists the properties endpoints 404; wait
  // for the run to be in progress rather than burn three failing calls a tick.
  if (state.run === undefined || state.run.status === 'starting') return false
  if (now - state.last_refresh_at < opts.update_interval_ms) return false
  return (
    state.dirty ||
    state.stream === 'disabled' ||
    state.tick % limits.safety_refresh_ticks === 0
  )
}

async function refresh(
  deps: WatchDeps,
  opts: WatchOptions,
  state: State
): Promise<void> {
  try {
    const [failing, passing] = await Promise.all([
      deps.client.list_properties(opts.run_id, 'Failing'),
      deps.client.list_properties(opts.run_id, 'Passing')
    ])
    const undetermined = await list_undetermined(deps, opts, failing, passing)
    state.snapshot = snapshot_from_lists(
      failing,
      passing,
      undetermined,
      deps.now()
    )
    state.dirty = false
    state.last_refresh_at = deps.now()
  } catch (error) {
    // Keep the old snapshot and stay dirty; the next tick tries again.
    deps.log.warning(
      `Could not list the run's properties: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * `--undetermined` is new in snouty 0.9.0. An older binary (reachable through
 * `snouty_path`) rejects the flag; list everything instead and subtract.
 */
async function list_undetermined(
  deps: WatchDeps,
  opts: WatchOptions,
  failing: Property[],
  passing: Property[]
): Promise<Property[]> {
  try {
    return await deps.client.list_properties(opts.run_id, 'Undetermined')
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'unsupported')
      throw error
    const known = new Set([...failing, ...passing].map(p => p.id))
    const all = await deps.client.list_properties(opts.run_id)
    return all.filter(p => !known.has(p.id))
  }
}

async function refresh_pending_status(
  deps: WatchDeps,
  opts: WatchOptions,
  limits: typeof DEFAULT_LIMITS,
  state: State
): Promise<void> {
  if (state.snapshot === undefined) return
  if (deps.now() - state.last_status_refresh_at < limits.status_refresh_ms)
    return
  state.last_status_refresh_at = deps.now()
  await deps.reporter.set_commit_status(
    'pending',
    render_status_description(view_for(opts, state, 'running', deps.now())),
    opts.run_url
  )
}

// ------------------------------------------------------------------------------
// E/F/G. Finalize
// ------------------------------------------------------------------------------

async function finish(
  deps: WatchDeps,
  opts: WatchOptions,
  state: State,
  outcome: WatchOutcome
): Promise<WatchOutcome> {
  state.stream = 'finalized'

  if (outcome.kind === 'aborted') {
    // The runner sends SIGKILL a few seconds after SIGTERM: one bounded edit.
    const edit = deps.reporter.upsert_comment(
      render_comment(view_for(opts, state, 'aborted', deps.now()))
    )
    await Promise.race([edit, deps.sleep(5000)])
    return { ...outcome, snapshot: state.snapshot }
  }

  // A final listing so the comment shows the last results. Not for a run that
  // failed before producing any: that listing would just fail too.
  if (outcome.kind !== 'api_error') await refresh(deps, opts, state)
  const with_snapshot = { ...outcome, snapshot: state.snapshot }

  const phase = phase_for(with_snapshot)
  const view = view_for(opts, state, phase, deps.now(), with_snapshot)
  await deps.reporter.upsert_comment(render_comment(view))

  const description = render_status_description(view)
  switch (with_snapshot.kind) {
    case 'completed':
      await deps.reporter.set_commit_status(
        'success',
        description,
        opts.run_url
      )
      break
    case 'run_failed':
    case 'api_error':
      await deps.reporter.set_commit_status('error', description, opts.run_url)
      break
    case 'timed_out':
      await deps.reporter.set_commit_status(
        'pending',
        description,
        opts.run_url
      )
      break
  }
  return with_snapshot
}

function phase_for(outcome: WatchOutcome): CommentPhase {
  switch (outcome.kind) {
    case 'completed':
      return 'completed'
    case 'run_failed':
      return 'run_failed'
    case 'api_error':
      return 'api_error'
    case 'timed_out':
      return 'timed_out'
    case 'aborted':
      return 'aborted'
  }
}

function view_for(
  opts: WatchOptions,
  state: State,
  phase: CommentPhase,
  now: number,
  outcome?: WatchOutcome
): CommentView {
  const waited_ms = now - state.started_at
  return {
    ...opts.view,
    phase,
    run_id: opts.run_id,
    run_url: opts.run_url,
    snapshot: state.snapshot,
    updated_at: new Date(now).toISOString(),
    status_label: outcome?.kind === 'run_failed' ? outcome.status : undefined,
    reason:
      outcome?.kind === 'run_failed'
        ? outcome.failure_reason
        : outcome?.kind === 'api_error'
          ? outcome.message
          : undefined,
    update_cadence: `about every ${Math.round(opts.update_interval_ms / 1000)}s`,
    waited_label: format_duration(waited_ms)
  }
}

function format_duration(ms: number): string {
  const total_minutes = Math.round(ms / 60_000)
  const hours = Math.floor(total_minutes / 60)
  const minutes = total_minutes % 60
  if (hours === 0) return `${minutes}m`
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
}

function any_signal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}
