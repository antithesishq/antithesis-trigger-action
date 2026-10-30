import * as core from '@actions/core'
import { context as github_context } from '@actions/github'
import type { ActionInputs } from './inputs'

type Context = typeof github_context

/* Literals which must match Antithesis-internal literals. */
export const INTEGRATIONS_TYPE_GITHUB = 'github' // identical to PARAM_INTEGRATIONS_TYPE_GITHUB

type CommitInfo = {
  'vcs.version_id': string
  'vcs.version_link': string
}

type PRInfo = {
  'vcs.pr_id': number
  'vcs.pr_link': string | undefined
  'vcs.pr_owner': string | undefined
  'vcs.pr_title': string | undefined
}

export function get_commit_info(ctx: Context = github_context): CommitInfo {
  const commit_link = `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/commit/${ctx.sha}`
  return {
    'vcs.version_id': ctx.sha,
    'vcs.version_link': commit_link
  }
}

export function get_pr_info(
  ctx: Context = github_context
): (PRInfo & Partial<CommitInfo>) | Record<PropertyKey, never> {
  const pr = ctx?.payload.pull_request
  if (pr === undefined) {
    core.info('The event that invoked this Action has no `pull_request`.')
    return {}
  }

  // Possibly override `get_commit_info()`: we only care about the feature commit.
  const commit_info_override =
    pr.head?.sha !== undefined && pr.head?.repo.html_url !== undefined
      ? {
          'vcs.version_id': pr.head.sha as string,
          'vcs.version_link': `${pr.head.repo.html_url}/commit/${pr.head.sha}`
        }
      : {}

  return {
    ...commit_info_override,
    'vcs.pr_id': pr.number,
    'vcs.pr_link': pr.html_url,
    'vcs.pr_owner': pr.user?.login,
    'vcs.pr_title': pr.title
  }
}

// ==============================================================================
// Mode detection
// ==============================================================================

export type ModeDecision =
  | { kind: 'skip'; reason: string }
  | { kind: 'fire-and-forget'; downgrade?: string }
  | { kind: 'comment'; slash_command: boolean }

/**
 * Recognise `/antithesis` on the first line of a comment. Anything after the
 * command is returned as `args` for logging; it has no effect yet.
 */
export function parse_slash_command(
  body: string | null | undefined
): { args: string } | undefined {
  if (!body) return undefined
  const first_line = body.split(/\r?\n/, 1)[0].trim()
  const match = /^\/antithesis(?:\s+(.*))?$/.exec(first_line)
  if (match === null) return undefined
  return { args: (match[1] ?? '').trim() }
}

/**
 * Decide between the historical fire-and-forget flow and the live comment
 * flow. An `/antithesis` comment on a pull request always means the comment
 * flow; otherwise the `mode` input decides, and the comment flow downgrades to
 * fire-and-forget when it cannot work.
 */
export function detect_mode(
  ctx: Context,
  inputs: Pick<ActionInputs, 'mode' | 'credentials' | 'github_token'>
): ModeDecision {
  if (ctx.eventName === 'issue_comment') {
    const command = parse_slash_command(ctx.payload.comment?.body)
    if (!ctx.payload.issue?.pull_request) {
      return { kind: 'skip', reason: 'the comment is not on a pull request' }
    }
    if (command === undefined) {
      return {
        kind: 'skip',
        reason: 'the comment does not start with /antithesis'
      }
    }
    if (command.args !== '') {
      // TODO: support `/antithesis key=value` overrides of the inputs.
      core.info(
        `Ignoring the arguments "${command.args}" after /antithesis: arguments are not supported yet.`
      )
    }
    return downgrade_if_unusable(
      { kind: 'comment', slash_command: true },
      inputs
    )
  }

  if (inputs.mode === 'fire-and-forget') return { kind: 'fire-and-forget' }

  if (ctx.payload.pull_request === undefined) {
    return {
      kind: 'fire-and-forget',
      downgrade: `mode "comment" needs a pull request, but the "${ctx.eventName}" event has none`
    }
  }
  return downgrade_if_unusable(
    { kind: 'comment', slash_command: false },
    inputs
  )
}

function downgrade_if_unusable(
  decision: ModeDecision,
  inputs: Pick<ActionInputs, 'credentials' | 'github_token'>
): ModeDecision {
  // The public API behind `snouty runs …` accepts API keys and OIDC tokens
  // only; a username/password can launch but cannot read results.
  if (inputs.credentials.kind === 'basic') {
    return {
      kind: 'fire-and-forget',
      downgrade:
        'live results need an api_key or GitHub Actions OIDC; username/password can only launch the run'
    }
  }
  if (inputs.github_token === '') {
    return {
      kind: 'fire-and-forget',
      downgrade:
        'live results need a github_token to post the pull request comment'
    }
  }
  return decision
}

// ==============================================================================
// Target resolution: which commit and pull request this run is about
// ==============================================================================

export interface PullRequestTarget {
  number: number
  html_url?: string
  title?: string
  user_login?: string
  head_ref?: string
}

export interface Target {
  owner: string
  repo: string
  /** The commit the GitHub commit status is posted on. */
  status_sha: string
  /** The commit reported to Antithesis as `vcs.version_id`. */
  version_sha: string
  version_link: string
  branch: string
  pr?: PullRequestTarget
  /** The `/antithesis` comment that triggered this run, if any. */
  trigger_comment_id?: number
}

/** The one GitHub read the action needs: the pull request behind a comment. */
export interface PullsApi {
  get_pull_request: (
    owner: string,
    repo: string,
    number: number
  ) => Promise<{
    head_sha: string
    head_repo_url?: string
    head_ref: string
    html_url: string
    title: string
    user_login?: string
  }>
}

function repo_slug(ctx: Context): { owner: string; repo: string } {
  const owner =
    ctx.payload.repository?.owner?.name ??
    ctx.payload.repository?.owner?.login ??
    ctx.repo.owner
  const repo = ctx.payload.repository?.name ?? ctx.repo.repo
  return { owner, repo }
}

export async function resolve_target(
  ctx: Context,
  decision: ModeDecision,
  pulls?: PullsApi
): Promise<Target> {
  const { owner, repo } = repo_slug(ctx)
  // nb: the ref may be a branch *or a tag!*
  const branch = ctx.ref?.replace('refs/heads/', '') ?? ''
  const commit = get_commit_info(ctx)

  if (decision.kind === 'comment' && decision.slash_command) {
    if (pulls === undefined) {
      throw new Error(
        'A GitHub client is required to resolve the pull request behind an /antithesis comment.'
      )
    }
    const number = ctx.payload.issue?.number as number
    const pr = await pulls.get_pull_request(owner, repo, number)
    const repo_url =
      pr.head_repo_url ?? `${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}`
    return {
      owner,
      repo,
      status_sha: pr.head_sha,
      version_sha: pr.head_sha,
      version_link: `${repo_url}/commit/${pr.head_sha}`,
      branch: pr.head_ref,
      pr: {
        number,
        html_url: pr.html_url,
        title: pr.title,
        user_login: pr.user_login,
        head_ref: pr.head_ref
      },
      trigger_comment_id: ctx.payload.comment?.id
    }
  }

  const payload_pr = ctx.payload.pull_request
  const pr_info = get_pr_info(ctx)
  const version_sha = pr_info['vcs.version_id'] ?? commit['vcs.version_id']
  const version_link = pr_info['vcs.version_link'] ?? commit['vcs.version_link']
  const pr: PullRequestTarget | undefined =
    payload_pr === undefined
      ? undefined
      : {
          number: payload_pr.number,
          html_url: payload_pr.html_url,
          title: payload_pr.title,
          user_login: payload_pr.user?.login,
          head_ref: payload_pr.head?.ref
        }

  // The comment flow follows the pull request's head commit, so the status
  // lands on the commit people see in the PR. Fire-and-forget keeps the
  // historical behaviour: status on `context.sha` (the merge commit for
  // pull_request events), version on the PR head.
  const on_head = decision.kind === 'comment' && pr !== undefined
  return {
    owner,
    repo,
    status_sha: on_head ? version_sha : ctx.sha,
    version_sha,
    version_link,
    branch: on_head && pr.head_ref !== undefined ? pr.head_ref : branch,
    pr
  }
}

/** The `vcs.*` launch parameters for a target, undefined values pruned later. */
export function build_vcs_params(
  target: Target,
  system_name: string | undefined
): Record<string, string | number | undefined> {
  return {
    'vcs.system_name': system_name,
    'vcs.repo_type': INTEGRATIONS_TYPE_GITHUB,
    'vcs.repo_owner': github_context.payload.repository?.owner?.login,
    'vcs.repo_name': github_context.payload.repository?.name,
    'vcs.repo_branch': target.branch,
    'vcs.version_id': target.version_sha,
    'vcs.version_link': target.version_link,
    ...(target.pr === undefined
      ? {}
      : {
          'vcs.pr_id': target.pr.number,
          'vcs.pr_link': target.pr.html_url,
          'vcs.pr_owner': target.pr.user_login,
          'vcs.pr_title': target.pr.title
        })
  }
}
