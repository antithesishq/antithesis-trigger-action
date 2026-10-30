import * as core from '@actions/core'
import { parse_additional_parameters, parse_duration } from './helpers'
import { DEFAULT_SNOUTY_VERSION } from './snouty-install'

/**
 * How the action authenticates to Antithesis. snouty reads each of these from
 * the environment; `oidc` means snouty mints a GitHub Actions OIDC token itself
 * from `ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
 */
export type Credentials =
  | { kind: 'api_key'; api_key: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'oidc' }

/**
 * `fire-and-forget` is the historical behaviour: launch, post a pending commit
 * status, exit. `comment` waits for the run and keeps a pull request comment
 * up to date with its property results.
 */
export type Mode = 'fire-and-forget' | 'comment'

export interface ActionInputs {
  notebook_name: string
  tenant: string
  credentials: Credentials
  github_token: string
  config_image: string
  images: string
  description: string
  team: string
  system_name: string
  test_name: string
  email_recipients: string
  additional_parameters: Record<string, string>
  mode: Mode
  poll_interval_ms: number
  update_interval_ms: number
  wait_timeout_ms: number
  comment_max_failures: number
  snouty_version: string
  snouty_path: string
}

export const MISSING_CREDENTIALS_MESSAGE =
  'Missing credentials: provide either `api_key`, or both `username` and `password`.'

export const INPUT_DEFAULTS = {
  poll_interval_ms: 30_000,
  min_poll_interval_ms: 15_000,
  update_interval_ms: 60_000,
  // Hosted runners kill a job at 6 hours and mark it failed; stop a little
  // earlier so a long run leaves the job green with a "still running" comment.
  wait_timeout_ms: (5 * 60 + 50) * 60_000,
  comment_max_failures: 25
} as const

const MODES: readonly Mode[] = ['fire-and-forget', 'comment']

function read_credentials(env: NodeJS.ProcessEnv): Credentials {
  const username = core.getInput('username')
  const password = core.getInput('password')
  const api_key = core.getInput('api_key')
  if (username) core.setSecret(username)
  if (password) core.setSecret(password)
  if (api_key) core.setSecret(api_key)

  if (api_key) return { kind: 'api_key', api_key }
  if (username && password) return { kind: 'basic', username, password }
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    core.info(
      'No api_key or username/password given; snouty will authenticate with the workflow’s GitHub Actions OIDC token.'
    )
    return { kind: 'oidc' }
  }
  throw new Error(MISSING_CREDENTIALS_MESSAGE)
}

function read_duration(
  name: string,
  fallback_ms: number,
  minimum_ms?: number
): number {
  const raw = core.getInput(name)
  let ms = raw === '' ? fallback_ms : parse_duration(raw)
  if (minimum_ms !== undefined && ms < minimum_ms) {
    core.warning(
      `${name} of ${raw} is below the minimum; using ${minimum_ms / 1000}s instead.`
    )
    ms = minimum_ms
  }
  return ms
}

function read_mode(): Mode {
  const raw = core.getInput('mode') || 'fire-and-forget'
  if (!MODES.includes(raw as Mode)) {
    throw new Error(
      `Invalid mode "${raw}": expected one of ${MODES.map(m => `"${m}"`).join(', ')}.`
    )
  }
  return raw as Mode
}

export function read_inputs(
  env: NodeJS.ProcessEnv = process.env
): ActionInputs {
  const credentials = read_credentials(env)
  const github_token = core.getInput('github_token')
  if (github_token) core.setSecret(github_token)

  const poll_interval_ms = read_duration(
    'poll_interval',
    INPUT_DEFAULTS.poll_interval_ms,
    INPUT_DEFAULTS.min_poll_interval_ms
  )
  const update_interval_ms = read_duration(
    'update_interval',
    INPUT_DEFAULTS.update_interval_ms,
    INPUT_DEFAULTS.min_poll_interval_ms
  )
  // 0 disables the action's own deadline and leaves it to the job's
  // `timeout-minutes`.
  const wait_timeout_ms = read_duration(
    'wait_timeout',
    INPUT_DEFAULTS.wait_timeout_ms
  )

  const raw_max_failures = core.getInput('comment_max_failures')
  const comment_max_failures =
    raw_max_failures === ''
      ? INPUT_DEFAULTS.comment_max_failures
      : Math.max(1, Number.parseInt(raw_max_failures, 10) || 1)

  return {
    notebook_name: core.getInput('notebook_name'),
    tenant: core.getInput('tenant'),
    credentials,
    github_token,
    config_image: core.getInput('config_image'),
    images: core.getInput('images'),
    description: core.getInput('description'),
    team: core.getInput('team'),
    system_name: core.getInput('system_name'),
    test_name: core.getInput('test_name'),
    email_recipients: core.getInput('email_recipients'),
    additional_parameters: parse_additional_parameters(
      core.getInput('additional_parameters')
    ),
    mode: read_mode(),
    poll_interval_ms,
    update_interval_ms,
    wait_timeout_ms,
    comment_max_failures,
    snouty_version: core.getInput('snouty_version') || DEFAULT_SNOUTY_VERSION,
    snouty_path: core.getInput('snouty_path')
  }
}
