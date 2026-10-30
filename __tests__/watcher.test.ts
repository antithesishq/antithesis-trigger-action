import type { Reporter } from '../src/github-reporter'
import { sleep } from '../src/helpers'
import {
  ApiError,
  type Property,
  type PropertyStatus,
  type RunDetail,
  type StreamEvent
} from '../src/snouty-client'
import { watch_run, type WatchClient, type WatchOptions } from '../src/watcher'

// ==============================================================================
// Scripted doubles
// ==============================================================================

type RunScript = RunDetail | ApiError
type StreamScript = { events: StreamEvent[]; end: 'exit0' | ApiError | 'hang' }

class FakeClient implements WatchClient {
  /** Consumed one per poll; the last entry repeats. */
  runs: RunScript[] = []
  properties: Record<PropertyStatus, Property[]> = {
    Failing: [],
    Passing: [],
    Undetermined: []
  }
  properties_error: ApiError | undefined
  /** Pretend to be a snouty older than 0.9.0, without `--undetermined`. */
  old_snouty = false
  /** Consumed one per open_stream; the last entry repeats. */
  streams: StreamScript[] = [{ events: [], end: 'hang' }]
  get_run_calls = 0
  list_calls = 0
  stream_opens = 0

  async get_run(): Promise<RunDetail> {
    this.get_run_calls += 1
    const next = this.runs.length > 1 ? this.runs.shift() : this.runs[0]
    if (next === undefined) throw new ApiError('no script', 'other')
    if (next instanceof ApiError) throw next
    return next
  }

  async list_properties(
    _run_id: string,
    status?: PropertyStatus
  ): Promise<Property[]> {
    this.list_calls += 1
    if (this.properties_error) throw this.properties_error
    if (status === 'Undetermined' && this.old_snouty) {
      throw new ApiError(
        "unexpected argument '--undetermined' found",
        'unsupported'
      )
    }
    return status
      ? this.properties[status]
      : Object.values(this.properties).flat()
  }

  async *open_stream(
    _run_id: string,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    this.stream_opens += 1
    const script =
      this.streams.length > 1 ? this.streams.shift() : this.streams[0]
    if (script === undefined) return
    for (const event of script.events) yield event
    if (script.end === 'exit0') return
    if (script.end instanceof ApiError) throw script.end
    // Hang until the watcher stops, like a quiet stream.
    await new Promise<void>(resolve =>
      signal.addEventListener('abort', () => resolve(), { once: true })
    )
  }
}

class FakeReporter implements Reporter {
  comments: string[] = []
  statuses: Array<{ state: string; description: string; target_url?: string }> =
    []
  fail = false
  async upsert_comment(body: string): Promise<boolean> {
    if (this.fail) return false
    this.comments.push(body)
    return true
  }
  async set_commit_status(
    state: string,
    description: string,
    target_url?: string
  ): Promise<boolean> {
    if (this.fail) return false
    this.statuses.push({ state, description, target_url })
    return true
  }
  async react(): Promise<boolean> {
    return true
  }
}

const run = (status: string, extra: Partial<RunDetail> = {}): RunDetail => ({
  run_id: 'r',
  status,
  ...extra
})
const prop = (id: string, status: PropertyStatus): Property => ({
  id,
  name: `prop ${id}`,
  status
})

function options(overrides: Partial<WatchOptions> = {}): WatchOptions {
  return {
    run_id: 'r',
    run_url: 'https://t.antithesis.com/run?run_id=r',
    view: {
      marker_key: 't',
      title: 't',
      commit_sha: 'abcdef1234',
      max_failures: 25
    },
    poll_interval_ms: 30_000,
    update_interval_ms: 60_000,
    wait_timeout_ms: 0,
    ...overrides
  }
}

/** Run the watcher under fake timers, advancing time until it settles. */
async function drive(
  client: FakeClient,
  reporter: FakeReporter,
  opts: WatchOptions,
  max_ms = 24 * 3600_000,
  signal = new AbortController().signal
): Promise<Awaited<ReturnType<typeof watch_run>>> {
  const log = { info: jest.fn(), warning: jest.fn() }
  let settled: Awaited<ReturnType<typeof watch_run>> | undefined
  const pending = (async (): Promise<Awaited<ReturnType<typeof watch_run>>> => {
    const outcome = await watch_run(
      { client, reporter, now: () => Date.now(), sleep, signal, log },
      opts
    )
    settled = outcome
    return outcome
  })()
  let elapsed = 0
  while (settled === undefined && elapsed < max_ms) {
    await jest.advanceTimersByTimeAsync(1000)
    elapsed += 1000
  }
  if (settled === undefined)
    throw new Error(`watcher did not settle within ${max_ms}ms`)
  return pending
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-10-30T00:00:00Z'))
})
afterEach(() => jest.useRealTimers())

// ==============================================================================
// Tests
// ==============================================================================

describe('watch_run happy path', () => {
  it('follows stream events, refreshes, comments, and finishes green on completion', async () => {
    const client = new FakeClient()
    client.runs = [
      run('starting'),
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('completed')
    ]
    client.properties.Failing = [prop('f1', 'Failing')]
    client.properties.Passing = [prop('p1', 'Passing'), prop('p2', 'Passing')]
    client.streams = [
      {
        events: [
          { event: 'open' },
          { event: 'verdict', property_id: 'f1', verdict: 'failed' },
          { event: 'completed', run_id: 'r' }
        ],
        end: 'exit0'
      }
    ]
    const reporter = new FakeReporter()
    const outcome = await drive(client, reporter, options())

    expect(outcome.kind).toBe('completed')
    expect(outcome.snapshot).toMatchObject({
      failing_count: 1,
      passing_count: 2,
      undetermined_count: 0
    })
    // The final comment and the success status both carry the run link.
    expect(reporter.comments.at(-1)).toContain('Completed')
    expect(reporter.comments.at(-1)).toContain('prop f1')
    expect(reporter.statuses.at(-1)).toEqual({
      state: 'success',
      description:
        'Antithesis run completed: 2/3 properties passing (1 failing).',
      target_url: 'https://t.antithesis.com/run?run_id=r'
    })
    // No property listing while the run was still starting.
    expect(client.list_calls % 3).toBe(0)
  })

  it('derives the undetermined count by subtraction on an old snouty', async () => {
    const client = new FakeClient()
    client.old_snouty = true
    client.runs = [run('in_progress'), run('completed')]
    client.properties.Failing = [prop('f1', 'Failing')]
    client.properties.Passing = [prop('p1', 'Passing')]
    client.properties.Undetermined = [
      prop('u1', 'Undetermined'),
      prop('u2', 'Undetermined')
    ]
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome.snapshot).toMatchObject({
      failing_count: 1,
      passing_count: 1,
      undetermined_count: 2
    })
  })

  it('does not list properties while the run is starting', async () => {
    const client = new FakeClient()
    client.runs = [run('starting'), run('starting'), run('completed')]
    const reporter = new FakeReporter()
    await drive(client, reporter, options())
    // Only the final refresh.
    expect(client.list_calls).toBe(3)
  })
})

describe('watch_run run failures', () => {
  it('reports an incomplete run with its reason and an error status', async () => {
    const client = new FakeClient()
    client.runs = [
      run('in_progress'),
      run('incomplete', { failure_reason: 'environment failed to build' })
    ]
    const reporter = new FakeReporter()
    const outcome = await drive(client, reporter, options())
    expect(outcome).toMatchObject({
      kind: 'run_failed',
      status: 'incomplete',
      failure_reason: 'environment failed to build'
    })
    expect(reporter.statuses.at(-1)).toMatchObject({
      state: 'error',
      description:
        'Antithesis run ended as incomplete: environment failed to build'
    })
    expect(reporter.comments.at(-1)).toContain('Did not complete (incomplete)')
  })

  it('treats a stream `finished` error as a request to finalize', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress'), run('cancelled')]
    client.streams = [
      {
        events: [],
        end: new ApiError(
          'run r has finished, and has no status stream',
          'finished'
        )
      }
    ]
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome).toMatchObject({ kind: 'run_failed', status: 'cancelled' })
  })
})

describe('watch_run status poll resilience', () => {
  it('tolerates 404s right after launch', async () => {
    const client = new FakeClient()
    const missing = new ApiError('run not found: r', 'not_found', 404)
    client.runs = [
      missing,
      missing,
      missing,
      run('in_progress'),
      run('completed')
    ]
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome.kind).toBe('completed')
  })

  it('gives up when the run never appears', async () => {
    const client = new FakeClient()
    client.runs = [new ApiError('run not found: r', 'not_found', 404)]
    const reporter = new FakeReporter()
    const outcome = await drive(client, reporter, options())
    expect(outcome).toMatchObject({
      kind: 'api_error',
      message: expect.stringContaining('never became visible')
    })
    expect(client.get_run_calls).toBe(11)
    expect(reporter.statuses.at(-1)).toMatchObject({ state: 'error' })
    expect(reporter.comments.at(-1)).toContain('Results unavailable')
  })

  it('gives up sooner when a seen run disappears', async () => {
    const client = new FakeClient()
    client.runs = [
      run('in_progress'),
      new ApiError('run not found: r', 'not_found', 404)
    ]
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome).toMatchObject({
      kind: 'api_error',
      message: expect.stringContaining('disappeared')
    })
    expect(client.get_run_calls).toBe(7)
  })

  it('fails fast on bad credentials', async () => {
    const client = new FakeClient()
    client.runs = [
      new ApiError('API error: 401 Unauthorized', 'unauthorized', 401)
    ]
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome).toMatchObject({
      kind: 'api_error',
      message: expect.stringContaining('credentials')
    })
    expect(client.get_run_calls).toBe(1)
  })

  it('backs off on transient errors and recovers', async () => {
    const client = new FakeClient()
    const flaky = new ApiError('API error: 503 unavailable', 'server', 503)
    client.runs = [flaky, flaky, run('in_progress'), run('completed')]
    const started = Date.now()
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome.kind).toBe('completed')
    // 60s + 120s of backoff before the two successful polls.
    expect(Date.now() - started).toBeGreaterThanOrEqual(180_000)
  })

  it('gives up after too many consecutive errors', async () => {
    const client = new FakeClient()
    client.runs = [new ApiError('API error: 503 unavailable', 'server', 503)]
    const outcome = await drive(
      client,
      new FakeReporter(),
      options(),
      48 * 3600_000
    )
    expect(outcome).toMatchObject({
      kind: 'api_error',
      message: expect.stringContaining('21 times')
    })
  })
})

describe('watch_run stream handling', () => {
  it('falls back to polling when the stream is unsupported, refreshing every eligible tick', async () => {
    const client = new FakeClient()
    client.runs = [
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('completed')
    ]
    client.streams = [
      {
        events: [],
        end: new ApiError('run r has no status stream', 'unsupported')
      }
    ]
    const reporter = new FakeReporter()
    const outcome = await drive(client, reporter, options())
    expect(outcome.kind).toBe('completed')
    expect(client.stream_opens).toBe(1)
    // 5 in-progress polls over 150s with a 60s debounce: refreshes at t=0, 60, 120, plus the final one.
    expect(client.list_calls).toBe(4 * 3)
  })

  it('reconnects after the stream ends early, with growing backoff', async () => {
    const client = new FakeClient()
    client.runs = [
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('completed')
    ]
    const early = new ApiError(
      'the stream ended before the run was final',
      'ended_early'
    )
    client.streams = [
      { events: [{ event: 'open' }], end: early },
      { events: [], end: early },
      { events: [{ event: 'open' }], end: 'hang' }
    ]
    const outcome = await drive(client, new FakeReporter(), options())
    expect(outcome.kind).toBe('completed')
    expect(client.stream_opens).toBe(3)
  })

  it('disables the stream after it keeps failing without events', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress')]
    client.streams = [
      {
        events: [],
        end: new ApiError(
          'the stream ended before the run was final',
          'ended_early'
        )
      }
    ]
    const reporter = new FakeReporter()
    const log_opens_before = client.stream_opens
    // Give up after the wait timeout; what matters is the stream stops reconnecting.
    const outcome = await drive(
      client,
      reporter,
      options({ wait_timeout_ms: 15 * 60_000 })
    )
    expect(outcome.kind).toBe('timed_out')
    // Backoff 1,2,4,…,60s then every 60s for 10 minutes: well under 30 attempts, and none after disabling.
    expect(client.stream_opens - log_opens_before).toBeLessThan(30)
  })

  it('finalizes when the stream says completed but the status lags, after a grace period', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress')]
    client.streams = [
      { events: [{ event: 'completed', run_id: 'r' }], end: 'exit0' }
    ]
    const outcome = await drive(
      client,
      new FakeReporter(),
      options({ finalize_grace_ticks: 2 })
    )
    expect(outcome).toMatchObject({ kind: 'run_failed', status: 'unknown' })
    expect(client.get_run_calls).toBeLessThanOrEqual(4)
  })
})

describe('watch_run comment cadence and GitHub failures', () => {
  it('writes the comment at most once per update interval while running', async () => {
    const client = new FakeClient()
    client.runs = [
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('in_progress'),
      run('completed')
    ]
    client.streams = [
      {
        events: [
          { event: 'open' },
          { event: 'verdict', property_id: 'a', verdict: 'failed' },
          { event: 'verdict', property_id: 'b', verdict: 'failed' },
          { event: 'sample', property_id: 'a', kind: 'counterexample' }
        ],
        end: 'hang'
      }
    ]
    const reporter = new FakeReporter()
    await drive(client, reporter, options())
    // 4 in-progress ticks over 90s → refreshes at t≈0 and t≈60, plus the final comment.
    expect(reporter.comments).toHaveLength(3)
    expect(reporter.comments[0]).toContain('Running')
    expect(reporter.comments.at(-1)).toContain('Completed')
  })

  it('keeps going when GitHub writes fail and when the listing fails', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress'), run('in_progress'), run('completed')]
    client.properties_error = new ApiError(
      'API error: 429 Too Many Requests',
      'rate_limited',
      429
    )
    const reporter = new FakeReporter()
    reporter.fail = true
    const outcome = await drive(client, reporter, options())
    expect(outcome.kind).toBe('completed')
    expect(outcome.snapshot).toBeUndefined()
  })

  it('refreshes the pending status with live counts every five minutes', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress')]
    client.properties.Passing = [prop('p', 'Passing')]
    const reporter = new FakeReporter()
    await drive(client, reporter, options({ wait_timeout_ms: 11 * 60_000 }))
    const pending = reporter.statuses.filter(s => s.state === 'pending')
    expect(pending.length).toBeGreaterThanOrEqual(3) // t=5m, t=10m, and the timed-out one
    expect(pending[0].description).toBe(
      'Antithesis is running: 1 passing, 0 failing, 0 undetermined.'
    )
  })
})

describe('watch_run deadline and cancellation', () => {
  it('leaves the run pending and the job green at the wait timeout', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress')]
    const reporter = new FakeReporter()
    const outcome = await drive(
      client,
      reporter,
      options({ wait_timeout_ms: 2 * 60_000 })
    )
    expect(outcome.kind).toBe('timed_out')
    expect(reporter.statuses.at(-1)).toMatchObject({
      state: 'pending',
      description: 'Antithesis is still running; this workflow stopped waiting.'
    })
    expect(reporter.comments.at(-1)).toContain('Still running')
    expect(reporter.comments.at(-1)).toContain('after 2m')
  })

  it('makes one last edit when the job is cancelled', async () => {
    const client = new FakeClient()
    client.runs = [run('in_progress')]
    const reporter = new FakeReporter()
    const controller = new AbortController()
    const log = { info: jest.fn(), warning: jest.fn() }
    const pending = watch_run(
      {
        client,
        reporter,
        now: () => Date.now(),
        sleep,
        signal: controller.signal,
        log
      },
      options()
    )
    await jest.advanceTimersByTimeAsync(45_000)
    controller.abort()
    await jest.advanceTimersByTimeAsync(10_000)
    const outcome = await pending
    expect(outcome.kind).toBe('aborted')
    expect(reporter.comments.at(-1)).toContain('workflow was cancelled')
    // No final status: the run is still going.
    expect(reporter.statuses.every(s => s.state === 'pending')).toBe(true)
  })
})
