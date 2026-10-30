import { context, getOctokit } from '@actions/github'
import * as core from '@actions/core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  build_vcs_params,
  detect_mode,
  get_commit_info,
  get_pr_info,
  INTEGRATIONS_TYPE_GITHUB,
  resolve_target,
  type ModeDecision,
  type PullsApi,
  type Target
} from './context'
import { shallow_prune_undefined_values, sleep } from './helpers'
import { read_inputs, type ActionInputs } from './inputs'
import {
  GithubReporter,
  NullReporter,
  octokit_api,
  type Reporter
} from './github-reporter'
import { render_comment, render_status_description } from './comment-render'
import { ensure_snouty } from './snouty-install'
import { SnoutyClient } from './snouty-client'
import { watch_run, type WatchOutcome } from './watcher'

// Kept for callers and tests that import them from here.
export { get_commit_info, get_pr_info }

/** The name of this GitHub Action. Used as `params["run.caller_name"]`. */
const THIS_ACTION = 'antithesis-trigger-action'

/* Literals which must match Antithesis-internal literals. */
const GITHUB_ACTION = 'github_action' // identical to our KNOWN_RUN_CREATOR_TYPE.GITHUB_ACTION

type Octokit = ReturnType<typeof getOctokit>

function status_context(test_name: string): string {
  return test_name
    ? `continuous-testing/antithesis (${test_name})`
    : 'continuous-testing/antithesis'
}

function pulls_api(octokit: Octokit): PullsApi {
  return {
    async get_pull_request(owner, repo, pull_number) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number
      })
      return {
        head_sha: data.head.sha,
        head_repo_url: data.head.repo?.html_url,
        head_ref: data.head.ref,
        html_url: data.html_url,
        title: data.title,
        user_login: data.user?.login
      }
    }
  }
}

/**
 * The launch parameters, identical in content to the pre-snouty request body.
 * The GitHub callback parameters are only sent in fire-and-forget mode: there
 * Antithesis flips the commit status when the run ends. In comment mode the
 * action is still around at the end and owns the status itself, so the final
 * link can point at the single run view.
 */
function build_launch_params(
  inputs: ActionInputs,
  target: Target,
  decision: ModeDecision
): Record<string, string> {
  const run_params = {
    'run.creator_name': context.actor,
    'run.team': inputs.team || undefined,
    'run.cron_schedule': context.payload.schedule as string | undefined,
    'run.caller_name': THIS_ACTION,
    'run.caller_type': GITHUB_ACTION
  }

  const callback_url = callback_url_for(target)
  const integrations_params =
    decision.kind === 'fire-and-forget' && inputs.github_token && callback_url
      ? {
          // these are deprecated:
          'antithesis.integrations.type': INTEGRATIONS_TYPE_GITHUB,
          'antithesis.integrations.callback_url': callback_url,
          'antithesis.integrations.token': inputs.github_token,

          // these aren't:
          'antithesis.integrations.github.callback_url': callback_url,
          'antithesis.integrations.github.token': inputs.github_token
        }
      : {}

  const all: Record<string, string | number | undefined> = {
    ...run_params,
    ...build_vcs_params(target, inputs.system_name || undefined),
    ...integrations_params,

    'antithesis.images': inputs.images || undefined,
    'antithesis.config_image': inputs.config_image || undefined,
    'antithesis.source': target.branch,
    'antithesis.description': inputs.description || undefined,
    'antithesis.report.recipients': inputs.email_recipients || undefined,
    'antithesis.test_name': inputs.test_name || undefined,

    ...inputs.additional_parameters
  }
  const pruned = shallow_prune_undefined_values(all)
  return Object.fromEntries(
    Object.entries(pruned).map(([k, v]) => [k, String(v)])
  )
}

/** The repository's commit-status URL for the status commit, as Antithesis's callback expects it. */
function callback_url_for(target: Target): string | undefined {
  const statuses_url = context.payload.repository?.statuses_url as
    | string
    | undefined
  return statuses_url !== undefined
    ? `${statuses_url.replace('{sha}', '')}${target.status_sha}`
    : undefined
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  let work_dir: string | undefined
  try {
    const inputs = read_inputs()
    const decision = detect_mode(context, inputs)
    if (decision.kind === 'skip') {
      core.info(`Nothing to do: ${decision.reason}.`)
      core.setOutput('result', 'Skipped')
      return
    }
    if (decision.kind === 'fire-and-forget' && decision.downgrade) {
      core.warning(`Falling back to fire-and-forget: ${decision.downgrade}.`)
    }
    core.info(`Mode: ${decision.kind}`)

    const octokit = inputs.github_token
      ? getOctokit(inputs.github_token)
      : undefined
    const target = await resolve_target(
      context,
      decision,
      octokit && pulls_api(octokit)
    )
    core.info(`Commit: ${target.version_sha}`)
    core.info(`Source: ${target.branch}`)
    core.info(
      `Additional Parameters: ${JSON.stringify(inputs.additional_parameters)}`
    )

    const reporter: Reporter = octokit
      ? new GithubReporter(
          octokit_api(octokit, target.owner, target.repo),
          { sha: target.status_sha, pr_number: target.pr?.number },
          inputs.test_name || inputs.notebook_name,
          status_context(inputs.test_name)
        )
      : new NullReporter()
    if (target.trigger_comment_id !== undefined) {
      await reporter.react(target.trigger_comment_id, 'eyes')
    }

    // snouty runs from an empty directory so a `.snouty.toml` in the checkout
    // (possibly from a fork) can never change its settings.
    work_dir = await mkdtemp(path.join(tmpdir(), 'antithesis-trigger-'))
    const binary = await ensure_snouty({
      version: inputs.snouty_version,
      preinstalled_path: inputs.snouty_path || undefined
    })
    const client = new SnoutyClient({
      binary,
      tenant: inputs.tenant,
      credentials: inputs.credentials,
      cwd: work_dir
    })

    const params = build_launch_params(inputs, target, decision)
    core.info(`Launching ${inputs.notebook_name} on ${inputs.tenant}`)
    const launched = await client.launch(inputs.notebook_name, params)
    const run_id = launched.run_id
    const run_url = run_id ? client.srv_url(run_id) : undefined
    core.info(
      `Successfully sent the request${launched.status_code ? `, status: ${launched.status_code}` : ''}${run_id ? `, run ${run_id}` : ''}`
    )
    if (run_id) core.setOutput('run_id', run_id)
    if (run_url) core.setOutput('run_url', run_url)

    if (decision.kind === 'fire-and-forget') {
      // Historical behaviour: a pending status that Antithesis later resolves
      // through the callback parameters, now linking the single run view.
      if (inputs.github_token && callback_url_for(target)) {
        await reporter.set_commit_status(
          'pending',
          'Antithesis is running your tests.',
          run_url
        )
      }
      if (run_id === undefined) {
        core.warning('Antithesis did not return a run id for this launch.')
      }
      core.setOutput('result', 'Success')
      return
    }

    await watch_and_report(inputs, target, reporter, client, run_id, run_url)
  } catch (error) {
    // Log only the message: snouty's command line carries credentials.
    const message = error instanceof Error ? error.message : String(error)
    core.error(`Failed to submit request : ${message}`)
    core.setFailed(message)
  } finally {
    if (work_dir !== undefined) {
      try {
        await rm(work_dir, { recursive: true, force: true })
      } catch {
        // A leftover temp dir on the runner is not worth failing the job for.
      }
    }
  }
}

async function watch_and_report(
  inputs: ActionInputs,
  target: Target,
  reporter: Reporter,
  client: SnoutyClient,
  run_id: string | undefined,
  run_url: string | undefined
): Promise<void> {
  const view = {
    marker_key: inputs.test_name || inputs.notebook_name,
    title: inputs.test_name || inputs.notebook_name,
    commit_sha: target.version_sha,
    max_failures: inputs.comment_max_failures
  }
  const now = new Date().toISOString()

  if (run_id === undefined || run_url === undefined) {
    const failed = {
      ...view,
      phase: 'api_error' as const,
      commit_sha: target.version_sha,
      updated_at: now,
      reason: 'Antithesis accepted the launch but returned no run id.'
    }
    await reporter.upsert_comment(render_comment(failed))
    await reporter.set_commit_status('error', render_status_description(failed))
    throw new Error('Antithesis accepted the launch but returned no run id.')
  }

  const launching = {
    ...view,
    phase: 'launching' as const,
    run_id,
    run_url,
    updated_at: now
  }
  await reporter.upsert_comment(render_comment(launching))
  await reporter.set_commit_status(
    'pending',
    render_status_description(launching),
    run_url
  )

  // Cancelling the job sends SIGTERM (then SIGKILL a few seconds later); the
  // watcher gets one bounded chance to say so in the comment.
  const abort = new AbortController()
  const on_signal = (): void => abort.abort()
  process.once('SIGINT', on_signal)
  process.once('SIGTERM', on_signal)

  let outcome: WatchOutcome
  try {
    outcome = await watch_run(
      {
        client,
        reporter,
        now: () => Date.now(),
        sleep,
        signal: abort.signal,
        log: { info: core.info, warning: core.warning }
      },
      {
        run_id,
        run_url,
        view,
        poll_interval_ms: inputs.poll_interval_ms,
        update_interval_ms: inputs.update_interval_ms,
        wait_timeout_ms: inputs.wait_timeout_ms
      }
    )
  } finally {
    process.removeListener('SIGINT', on_signal)
    process.removeListener('SIGTERM', on_signal)
  }

  const snapshot = outcome.snapshot
  core.setOutput('status', outcome.kind)
  core.setOutput('passing', String(snapshot?.passing_count ?? ''))
  core.setOutput('failing', String(snapshot?.failing_count ?? ''))
  core.setOutput('undetermined', String(snapshot?.undetermined_count ?? ''))

  switch (outcome.kind) {
    case 'completed':
      core.info(
        `Run ${run_id} completed: ${snapshot?.passing_count ?? '?'} passing, ${snapshot?.failing_count ?? '?'} failing.`
      )
      core.setOutput('result', 'Success')
      break
    case 'timed_out':
      core.warning(
        `Stopped waiting for run ${run_id}; it continues at ${run_url}`
      )
      core.setOutput('result', 'Success')
      break
    case 'aborted':
      core.setOutput('result', 'Success')
      break
    case 'run_failed':
      core.setOutput('result', 'Failed')
      core.setFailed(
        `Antithesis run ${run_id} ended as ${outcome.status}${outcome.failure_reason ? `: ${outcome.failure_reason}` : ''} (${run_url})`
      )
      break
    case 'api_error':
      core.setOutput('result', 'Failed')
      core.setFailed(
        `Could not follow Antithesis run ${run_id}: ${outcome.message} (${run_url})`
      )
      break
  }
}
