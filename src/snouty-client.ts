import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Credentials } from './inputs'

// ==============================================================================
// Process abstraction, so the client can be tested without a snouty binary
// ==============================================================================

export interface SpawnOptions {
  cwd: string
  env: Record<string, string>
}

export interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
}

export type ProcessEvent =
  | { source: 'stdout'; line: string }
  | { source: 'stderr'; line: string }
  | { source: 'exit'; code: number | null; error?: string }

export interface Spawner {
  run(cmd: string, args: string[], opts: SpawnOptions): Promise<SpawnResult>
  stream(
    cmd: string,
    args: string[],
    opts: SpawnOptions & { signal: AbortSignal }
  ): AsyncIterable<ProcessEvent>
}

export const node_spawner: Spawner = {
  async run(cmd, args, opts) {
    let stdout = ''
    let stderr = ''
    for await (const event of node_spawner.stream(cmd, args, {
      ...opts,
      signal: new AbortController().signal
    })) {
      if (event.source === 'stdout') stdout += `${event.line}\n`
      else if (event.source === 'stderr') stderr += `${event.line}\n`
      else {
        if (event.error !== undefined) stderr += `${event.error}\n`
        return { code: event.code, stdout, stderr }
      }
    }
    return { code: null, stdout, stderr }
  },

  async *stream(cmd, args, opts) {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    // Lines arrive on event callbacks; the generator drains them through a
    // queue and a one-shot wakeup so callers can `for await` the process.
    const queue: ProcessEvent[] = []
    let wake: (() => void) | undefined
    const push = (event: ProcessEvent): void => {
      queue.push(event)
      const w = wake
      wake = undefined
      w?.()
    }

    createInterface({ input: child.stdout }).on('line', line =>
      push({ source: 'stdout', line })
    )
    createInterface({ input: child.stderr }).on('line', line =>
      push({ source: 'stderr', line })
    )
    child.on('error', error =>
      push({ source: 'exit', code: null, error: error.message })
    )
    child.on('close', code => push({ source: 'exit', code }))

    const kill = (): void => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
    }
    opts.signal.addEventListener('abort', kill, { once: true })

    try {
      for (;;) {
        const next = queue.shift()
        if (next === undefined) {
          await new Promise<void>(resolve => {
            wake = resolve
          })
          continue
        }
        yield next
        if (next.source === 'exit') return
      }
    } finally {
      opts.signal.removeEventListener('abort', kill)
      kill()
    }
  }
}

// ==============================================================================
// Errors: snouty reports failures as text on stderr, exit code 1
// ==============================================================================

export type ApiErrorCode =
  | 'not_found'
  | 'rate_limited'
  | 'unauthorized'
  | 'conflict'
  | 'server'
  | 'ended_early'
  | 'unsupported'
  | 'finished'
  | 'other'

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number | undefined

  constructor(message: string, code: ApiErrorCode, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * Map snouty's stderr to an error the watcher can act on. The patterns come
 * from snouty's own messages (runs.rs, api.rs). The message never includes the
 * command line, which may carry tokens.
 */
export function classify_snouty_error(
  stderr: string,
  exit_code: number | null
): ApiError {
  const text = stderr.trim()
  const summary = summarize_stderr(text, exit_code)

  if (/the stream ended before the run was final/i.test(text)) {
    return new ApiError(summary, 'ended_early')
  }
  if (/has finished, and has no status stream/i.test(text)) {
    return new ApiError(summary, 'finished')
  }
  // Older snouty binaries: a missing subcommand or flag.
  if (
    /has no status stream|unrecognized subcommand|unexpected argument/i.test(
      text
    )
  ) {
    return new ApiError(summary, 'unsupported')
  }
  if (/run not found/i.test(text)) {
    return new ApiError(summary, 'not_found', 404)
  }
  const api_error = /API error: (\d{3})/.exec(text)
  if (api_error !== null) {
    const status = Number(api_error[1])
    if (status === 401 || status === 403) {
      return new ApiError(summary, 'unauthorized', status)
    }
    if (status === 404) return new ApiError(summary, 'not_found', status)
    if (status === 409) return new ApiError(summary, 'conflict', status)
    if (status === 429) return new ApiError(summary, 'rate_limited', status)
    if (status >= 500) return new ApiError(summary, 'server', status)
    return new ApiError(summary, 'other', status)
  }
  if (/credentials have been configured|unauthorized/i.test(text)) {
    return new ApiError(summary, 'unauthorized')
  }
  return new ApiError(summary, 'other')
}

function summarize_stderr(text: string, exit_code: number | null): string {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  // snouty prints progress on stderr too; the error is the last `Error:` line
  // (or whatever the last line is).
  const error_line = [...lines].reverse().find(l => /^Error:/i.test(l))
  const chosen = (error_line ?? lines.at(-1) ?? '').replace(/^Error:\s*/i, '')
  const message =
    chosen === '' ? `snouty exited with code ${exit_code ?? 'null'}` : chosen
  return message.length > 500 ? `${message.slice(0, 497)}...` : message
}

// ==============================================================================
// The client
// ==============================================================================

export interface RunDetail {
  run_id: string
  status: string
  sub_status?: string | null
  description?: string | null
  links?: { triage_report?: string | null } | null
  failure_reason?: string | null
}

export type PropertyStatus = 'Passing' | 'Failing' | 'Undetermined'

export interface Property {
  id: string
  name: string
  status: PropertyStatus | string
  group?: string | null
  is_group?: boolean
  is_event?: boolean
  example_count?: number
  counterexample_count?: number
}

/** One line of `snouty --json runs stream`, plus the "open" marker it logs on stderr. */
export type StreamEvent =
  | { event: 'open' }
  | { event: 'property'; property_id: string; name: string }
  | { event: 'sample'; property_id: string; kind: string }
  | { event: 'verdict'; property_id: string; verdict: string }
  | { event: 'completed'; run_id: string }
  | { event: 'unknown'; data: unknown }

export interface LaunchResult {
  run_id?: string
  status_code?: number
}

export interface SnoutyClientOptions {
  binary: string
  tenant: string
  credentials: Credentials
  /** An empty directory, so a repository's `.snouty.toml` is never read. */
  cwd: string
  spawner?: Spawner
  base_env?: NodeJS.ProcessEnv
}

export class SnoutyClient {
  private readonly spawner: Spawner

  constructor(private readonly opts: SnoutyClientOptions) {
    this.spawner = opts.spawner ?? node_spawner
  }

  /** The single run view in the tenant's dashboard. Built here: no API returns it. */
  srv_url(run_id: string): string {
    return `https://${this.opts.tenant}.antithesis.com/run?run_id=${encodeURIComponent(run_id)}`
  }

  /**
   * snouty resolves its tenant and credential from the environment. Everything
   * else is passed through (PATH, HOME, the OIDC request variables), but any
   * ANTITHESIS_* already set on the runner is dropped so it cannot override
   * the action's inputs.
   */
  env(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(
      this.opts.base_env ?? process.env
    )) {
      if (value !== undefined && !key.startsWith('ANTITHESIS_'))
        env[key] = value
    }
    env.ANTITHESIS_TENANT = this.opts.tenant
    const creds = this.opts.credentials
    if (creds.kind === 'api_key') env.ANTITHESIS_API_KEY = creds.api_key
    if (creds.kind === 'basic') {
      env.ANTITHESIS_USERNAME = creds.username
      env.ANTITHESIS_PASSWORD = creds.password
    }
    return env
  }

  private async run(args: string[]): Promise<SpawnResult> {
    const result = await this.spawner.run(this.opts.binary, args, {
      cwd: this.opts.cwd,
      env: this.env()
    })
    if (result.code !== 0)
      throw classify_snouty_error(result.stderr, result.code)
    return result
  }

  /**
   * `snouty launch`. Every parameter goes through `--param` (snouty accepts
   * the dedicated-flag parameters that way too), so the launch body is exactly
   * the parameter set the action built, with no flag/param precedence rules.
   */
  async launch(
    notebook_name: string,
    params: Record<string, string>
  ): Promise<LaunchResult> {
    const args = ['--json', 'launch', '--launcher', notebook_name, '--no-vcs']
    for (const [key, value] of Object.entries(params)) {
      args.push('--param', `${key}=${value}`)
    }
    const { stdout } = await this.run(args)
    const body = parse_json_object(stdout)
    return {
      run_id: typeof body.runId === 'string' ? body.runId : undefined,
      status_code:
        typeof body.statusCode === 'number' ? body.statusCode : undefined
    }
  }

  async get_run(run_id: string): Promise<RunDetail> {
    const { stdout } = await this.run(['--json', 'runs', 'show', run_id])
    return parse_json_object(stdout) as unknown as RunDetail
  }

  /** All of a run's properties with `status`, or every property when omitted. */
  async list_properties(
    run_id: string,
    status?: PropertyStatus
  ): Promise<Property[]> {
    const args = ['--json', 'runs', 'properties', run_id]
    if (status !== undefined) args.push(`--${status.toLowerCase()}`)
    const { stdout } = await this.run(args)
    return parse_ndjson(stdout) as Property[]
  }

  /**
   * `snouty runs stream`. Yields `open` when snouty reports the stream is
   * open, then one event per stdout line. Returns after snouty exits 0 (which
   * it only does after `completed`); throws a classified ApiError otherwise.
   */
  async *open_stream(
    run_id: string,
    signal: AbortSignal
  ): AsyncIterable<StreamEvent> {
    let stderr = ''
    const events = this.spawner.stream(
      this.opts.binary,
      ['--json', 'runs', 'stream', run_id],
      { cwd: this.opts.cwd, env: this.env(), signal }
    )
    for await (const event of events) {
      if (event.source === 'stderr') {
        stderr += `${event.line}\n`
        if (/the stream of run .* is open/.test(event.line)) {
          yield { event: 'open' }
        }
      } else if (event.source === 'stdout') {
        yield parse_stream_line(event.line)
      } else {
        if (event.code === 0) return
        if (event.error !== undefined) stderr += `${event.error}\n`
        throw classify_snouty_error(stderr, event.code)
      }
    }
  }
}

function parse_json_object(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (trimmed === '') {
    throw new ApiError('snouty printed no JSON', 'other')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new ApiError('snouty printed output that is not JSON', 'other')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('snouty printed JSON that is not an object', 'other')
  }
  return parsed as Record<string, unknown>
}

function parse_ndjson(text: string): unknown[] {
  const records: unknown[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      throw new ApiError('snouty printed a line that is not JSON', 'other')
    }
  }
  return records
}

export function parse_stream_line(line: string): StreamEvent {
  try {
    const parsed: unknown = JSON.parse(line)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { event?: unknown }).event === 'string'
    ) {
      return parsed as StreamEvent
    }
    return { event: 'unknown', data: parsed }
  } catch {
    return { event: 'unknown', data: line }
  }
}
