import * as core from '@actions/core'
import { context as github_context } from '@actions/github'
import {
  build_vcs_params,
  detect_mode,
  get_pr_info,
  parse_slash_command,
  resolve_target,
  type PullsApi
} from '../src/context'
import type { Credentials } from '../src/inputs'

type Context = typeof github_context

function fake_context(overrides: {
  eventName?: string
  payload?: Record<string, unknown>
  ref?: string
  sha?: string
}): Context {
  return {
    eventName: overrides.eventName ?? 'push',
    payload: overrides.payload ?? {},
    ref: overrides.ref ?? 'refs/heads/feature',
    sha: overrides.sha ?? 'c0ffee0000000000000000000000000000000000',
    serverUrl: 'https://github.com',
    actor: 'octocat',
    repo: { owner: 'ctx-owner', repo: 'ctx-repo' }
  } as unknown as Context
}

const api_key: Credentials = { kind: 'api_key', api_key: 'k' }
const basic: Credentials = { kind: 'basic', username: 'u', password: 'p' }

const pr_payload = {
  repository: {
    name: 'repo_name',
    owner: { login: 'owner_login' },
    statuses_url: 'https://api.github.com/repos/o/r/statuses/{sha}'
  },
  pull_request: {
    number: 42,
    html_url: 'https://github.com/o/r/pull/42',
    title: 'Fix it',
    user: { login: 'author' },
    head: {
      sha: 'head000000000000000000000000000000000000',
      ref: 'feature',
      repo: { html_url: 'https://github.com/fork/r' }
    }
  }
}

describe('parse_slash_command', () => {
  it.each([
    ['/antithesis', ''],
    ['/antithesis   ', ''],
    ['  /antithesis test_name=x', 'test_name=x'],
    ['/antithesis\r\nmore text', ''],
    ['/antithesis run it\nsecond line', 'run it']
  ])('accepts %j', (body, args) => {
    expect(parse_slash_command(body)).toEqual({ args })
  })

  it.each([
    'please /antithesis',
    '/antithesisx',
    '/antithesis-now',
    'first line\n/antithesis',
    '',
    undefined,
    null
  ])('rejects %j', body => {
    expect(parse_slash_command(body)).toBeUndefined()
  })
})

describe('detect_mode', () => {
  beforeEach(() => {
    jest.spyOn(core, 'info').mockImplementation()
  })

  it('is fire-and-forget by default on any event', () => {
    for (const eventName of [
      'push',
      'schedule',
      'workflow_dispatch',
      'pull_request'
    ]) {
      const ctx = fake_context({ eventName, payload: pr_payload })
      expect(
        detect_mode(ctx, {
          mode: 'fire-and-forget',
          credentials: api_key,
          github_token: 't'
        })
      ).toEqual({ kind: 'fire-and-forget' })
    }
  })

  it('comments on pull_request and pull_request_target events in comment mode', () => {
    for (const eventName of ['pull_request', 'pull_request_target']) {
      const ctx = fake_context({ eventName, payload: pr_payload })
      expect(
        detect_mode(ctx, {
          mode: 'comment',
          credentials: api_key,
          github_token: 't'
        })
      ).toEqual({ kind: 'comment', slash_command: false })
    }
  })

  it('downgrades comment mode on events without a pull request', () => {
    const ctx = fake_context({ eventName: 'push', payload: { repository: {} } })
    const decision = detect_mode(ctx, {
      mode: 'comment',
      credentials: api_key,
      github_token: 't'
    })
    expect(decision.kind).toBe('fire-and-forget')
    expect(decision).toHaveProperty(
      'downgrade',
      expect.stringContaining('push')
    )
  })

  it('downgrades comment mode with basic auth or without a token', () => {
    const ctx = fake_context({ eventName: 'pull_request', payload: pr_payload })
    expect(
      detect_mode(ctx, {
        mode: 'comment',
        credentials: basic,
        github_token: 't'
      })
    ).toMatchObject({
      kind: 'fire-and-forget',
      downgrade: expect.stringContaining('api_key')
    })
    expect(
      detect_mode(ctx, {
        mode: 'comment',
        credentials: api_key,
        github_token: ''
      })
    ).toMatchObject({
      kind: 'fire-and-forget',
      downgrade: expect.stringContaining('github_token')
    })
  })

  it('treats /antithesis on a PR comment as comment mode even in the default mode', () => {
    const ctx = fake_context({
      eventName: 'issue_comment',
      payload: {
        issue: { number: 7, pull_request: { url: 'x' } },
        comment: { id: 99, body: '/antithesis' }
      }
    })
    expect(
      detect_mode(ctx, {
        mode: 'fire-and-forget',
        credentials: api_key,
        github_token: 't'
      })
    ).toEqual({ kind: 'comment', slash_command: true })
  })

  it('logs and ignores arguments after /antithesis', () => {
    const info = jest.spyOn(core, 'info').mockImplementation()
    const ctx = fake_context({
      eventName: 'issue_comment',
      payload: {
        issue: { number: 7, pull_request: { url: 'x' } },
        comment: { id: 99, body: '/antithesis test_name=foo' }
      }
    })
    detect_mode(ctx, {
      mode: 'fire-and-forget',
      credentials: api_key,
      github_token: 't'
    })
    expect(info).toHaveBeenCalledWith(expect.stringContaining('test_name=foo'))
  })

  it('skips comments that are not commands or not on a pull request', () => {
    const not_command = fake_context({
      eventName: 'issue_comment',
      payload: {
        issue: { number: 7, pull_request: { url: 'x' } },
        comment: { id: 99, body: 'looks good' }
      }
    })
    expect(
      detect_mode(not_command, {
        mode: 'comment',
        credentials: api_key,
        github_token: 't'
      })
    ).toMatchObject({
      kind: 'skip',
      reason: expect.stringContaining('/antithesis')
    })

    const not_pr = fake_context({
      eventName: 'issue_comment',
      payload: {
        issue: { number: 7 },
        comment: { id: 99, body: '/antithesis' }
      }
    })
    expect(
      detect_mode(not_pr, {
        mode: 'comment',
        credentials: api_key,
        github_token: 't'
      })
    ).toMatchObject({
      kind: 'skip',
      reason: expect.stringContaining('pull request')
    })
  })
})

describe('resolve_target', () => {
  beforeEach(() => {
    jest.spyOn(core, 'info').mockImplementation()
  })

  it('fire-and-forget keeps the status on context.sha and the version on the PR head', async () => {
    const ctx = fake_context({
      eventName: 'pull_request',
      payload: pr_payload,
      ref: 'refs/pull/42/merge'
    })
    const target = await resolve_target(ctx, { kind: 'fire-and-forget' })
    expect(target).toMatchObject({
      owner: 'owner_login',
      repo: 'repo_name',
      status_sha: ctx.sha,
      version_sha: pr_payload.pull_request.head.sha,
      version_link: `https://github.com/fork/r/commit/${pr_payload.pull_request.head.sha}`,
      branch: 'refs/pull/42/merge',
      pr: {
        number: 42,
        head_ref: 'feature',
        title: 'Fix it',
        user_login: 'author'
      }
    })
  })

  it('comment mode follows the PR head commit and branch', async () => {
    const ctx = fake_context({
      eventName: 'pull_request',
      payload: pr_payload,
      ref: 'refs/pull/42/merge'
    })
    const target = await resolve_target(ctx, {
      kind: 'comment',
      slash_command: false
    })
    expect(target.status_sha).toBe(pr_payload.pull_request.head.sha)
    expect(target.version_sha).toBe(pr_payload.pull_request.head.sha)
    expect(target.branch).toBe('feature')
  })

  it('a push without a PR uses the commit and the branch', async () => {
    const ctx = fake_context({
      payload: { repository: { name: 'r', owner: { name: 'own', login: 'o' } } }
    })
    const target = await resolve_target(ctx, { kind: 'fire-and-forget' })
    expect(target).toMatchObject({
      owner: 'own',
      repo: 'r',
      status_sha: ctx.sha,
      version_sha: ctx.sha,
      version_link: `https://github.com/ctx-owner/ctx-repo/commit/${ctx.sha}`,
      branch: 'feature'
    })
    expect(target.pr).toBeUndefined()
  })

  it('a slash command resolves the PR through the API', async () => {
    const ctx = fake_context({
      eventName: 'issue_comment',
      sha: 'de7au1700000000000000000000000000000000',
      payload: {
        repository: { name: 'r', owner: { login: 'o' } },
        issue: { number: 7, pull_request: { url: 'x' } },
        comment: { id: 99, body: '/antithesis' }
      }
    })
    const pulls: PullsApi = {
      get_pull_request: jest.fn().mockResolvedValue({
        head_sha: 'head7',
        head_repo_url: undefined,
        head_ref: 'topic',
        html_url: 'https://github.com/o/r/pull/7',
        title: 'Topic',
        user_login: 'someone'
      })
    }
    const target = await resolve_target(
      ctx,
      { kind: 'comment', slash_command: true },
      pulls
    )
    expect(pulls.get_pull_request).toHaveBeenCalledWith('o', 'r', 7)
    expect(target).toMatchObject({
      status_sha: 'head7',
      version_sha: 'head7',
      // No head repo (deleted fork): fall back to the base repository.
      version_link: 'https://github.com/ctx-owner/ctx-repo/commit/head7',
      branch: 'topic',
      pr: { number: 7, head_ref: 'topic', user_login: 'someone' },
      trigger_comment_id: 99
    })
  })

  it('a slash command without a GitHub client is an error', async () => {
    const ctx = fake_context({
      eventName: 'issue_comment',
      payload: { issue: { number: 1 }, comment: {} }
    })
    await expect(
      resolve_target(ctx, { kind: 'comment', slash_command: true })
    ).rejects.toThrow(/GitHub client/)
  })
})

describe('build_vcs_params', () => {
  it('includes the pull request fields only when there is one', async () => {
    const ctx = fake_context({ eventName: 'pull_request', payload: pr_payload })
    github_context.payload = pr_payload
    const target = await resolve_target(ctx, { kind: 'fire-and-forget' })
    expect(build_vcs_params(target, 'sys')).toMatchObject({
      'vcs.system_name': 'sys',
      'vcs.repo_type': 'github',
      'vcs.repo_owner': 'owner_login',
      'vcs.repo_name': 'repo_name',
      'vcs.pr_id': 42,
      'vcs.pr_link': 'https://github.com/o/r/pull/42'
    })
    const no_pr = await resolve_target(
      fake_context({ payload: { repository: pr_payload.repository } }),
      { kind: 'fire-and-forget' }
    )
    expect(build_vcs_params(no_pr, undefined)).not.toHaveProperty(['vcs.pr_id'])
  })
})

describe('reasonable_pr_info', () => {
  it('undefined context.payload.pull_request returns {}', async () => {
    jest.spyOn(core, 'info').mockImplementation()
    expect(get_pr_info(fake_context({ payload: {} }))).toEqual({})
  })

  it("mostly-empty payload.pull_request doesn't override commit info", async () => {
    const pr_info = get_pr_info(
      fake_context({ payload: { pull_request: { number: 1 } } })
    )
    expect(pr_info).not.toHaveProperty(['vcs.version_id'])
    expect(pr_info).not.toHaveProperty(['vcs.version_link'])
  })

  it('payload.pull_request overrides commit info if possible', async () => {
    const pr_info = get_pr_info(
      fake_context({
        payload: {
          pull_request: {
            head: { sha: 'deadbeef', repo: { html_url: 'https://github.com' } },
            number: 1
          }
        }
      })
    )
    expect(pr_info).toHaveProperty(['vcs.version_id'])
    expect(pr_info).toHaveProperty(['vcs.version_link'])
  })
})
