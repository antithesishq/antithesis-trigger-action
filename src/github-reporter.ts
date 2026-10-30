import * as core from '@actions/core'
import type { getOctokit } from '@actions/github'
import { has_marker } from './comment-render'

export type CommitState = 'pending' | 'success' | 'failure' | 'error'

/** The GitHub writes the action makes, narrowed so tests can fake them. */
export interface GithubApi {
  list_comments: (
    issue_number: number
  ) => Promise<Array<{ id: number; body?: string | null }>>
  create_comment: (issue_number: number, body: string) => Promise<number>
  update_comment: (comment_id: number, body: string) => Promise<void>
  create_commit_status: (
    sha: string,
    state: CommitState,
    description: string,
    context: string,
    target_url?: string
  ) => Promise<void>
  react_to_comment: (
    comment_id: number,
    content: 'eyes' | 'rocket'
  ) => Promise<void>
}

type Octokit = ReturnType<typeof getOctokit>

/** Adapt a real octokit to the narrow `GithubApi`. */
export function octokit_api(
  octokit: Octokit,
  owner: string,
  repo: string
): GithubApi {
  return {
    async list_comments(issue_number) {
      return octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number,
        per_page: 100
      })
    },
    async create_comment(issue_number, body) {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body
      })
      return data.id
    },
    async update_comment(comment_id, body) {
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id,
        body
      })
    },
    async create_commit_status(sha, state, description, context, target_url) {
      await octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state,
        description,
        context,
        target_url
      })
    },
    async react_to_comment(comment_id, content) {
      await octokit.rest.reactions.createForIssueComment({
        owner,
        repo,
        comment_id,
        content
      })
    }
  }
}

/** What the watcher needs from GitHub. Every method is best-effort. */
export interface Reporter {
  upsert_comment(body: string): Promise<boolean>
  set_commit_status(
    state: CommitState,
    description: string,
    target_url?: string
  ): Promise<boolean>
  react(comment_id: number, content: 'eyes' | 'rocket'): Promise<boolean>
}

export interface ReporterTarget {
  sha: string
  pr_number?: number
}

/**
 * Posts to one commit and (optionally) one pull request. GitHub failures are
 * logged as warnings and reported as `false`: the run's outcome never depends
 * on whether GitHub accepted a write.
 */
export class GithubReporter implements Reporter {
  private comment_id: number | undefined

  constructor(
    private readonly api: GithubApi,
    private readonly target: ReporterTarget,
    private readonly marker_key: string,
    private readonly status_context: string,
    private readonly warn: (message: string) => void = core.warning
  ) {}

  async upsert_comment(body: string): Promise<boolean> {
    if (this.target.pr_number === undefined) return false
    try {
      if (this.comment_id === undefined) {
        this.comment_id = await this.find_comment(this.target.pr_number)
      }
      if (this.comment_id === undefined) {
        this.comment_id = await this.api.create_comment(
          this.target.pr_number,
          body
        )
      } else {
        await this.api.update_comment(this.comment_id, body)
      }
      return true
    } catch (error) {
      this.warn(`Could not update the pull request comment: ${describe(error)}`)
      return false
    }
  }

  /** The newest existing comment of ours for this test, if any. */
  private async find_comment(pr_number: number): Promise<number | undefined> {
    const comments = await this.api.list_comments(pr_number)
    const ours = comments.filter(c => has_marker(c.body, this.marker_key))
    return ours.at(-1)?.id
  }

  async set_commit_status(
    state: CommitState,
    description: string,
    target_url?: string
  ): Promise<boolean> {
    try {
      await this.api.create_commit_status(
        this.target.sha,
        state,
        description,
        this.status_context,
        target_url
      )
      return true
    } catch (error) {
      this.warn(`Could not post the commit status: ${describe(error)}`)
      return false
    }
  }

  async react(
    comment_id: number,
    content: 'eyes' | 'rocket'
  ): Promise<boolean> {
    try {
      await this.api.react_to_comment(comment_id, content)
      return true
    } catch (error) {
      this.warn(`Could not react to the comment: ${describe(error)}`)
      return false
    }
  }
}

/** For runs with nowhere to report to (no token): every write is a no-op. */
export class NullReporter implements Reporter {
  async upsert_comment(): Promise<boolean> {
    return false
  }
  async set_commit_status(): Promise<boolean> {
    return false
  }
  async react(): Promise<boolean> {
    return false
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
