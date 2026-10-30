/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import * as core from '@actions/core'
import * as github from '@actions/github'
import * as main from '../src/main'
import * as watcher from '../src/watcher'
import { ApiError } from '../src/snouty-client'

const mock_launch = jest.fn()
const mock_get_run = jest.fn()
const mock_list_properties = jest.fn()
const mock_open_stream = jest.fn()
let mock_client_options: Record<string, unknown> | undefined

jest.mock('../src/snouty-install', () => ({
  DEFAULT_SNOUTY_VERSION: '0.9.0-rc.1',
  ensure_snouty: jest.fn(async () => '/fake/snouty')
}))

jest.mock('../src/snouty-client', () => {
  const actual = jest.requireActual('../src/snouty-client')
  return {
    ...actual,
    SnoutyClient: jest
      .fn()
      .mockImplementation((opts: Record<string, unknown>) => {
        mock_client_options = opts
        return {
          launch: mock_launch,
          get_run: mock_get_run,
          list_properties: mock_list_properties,
          open_stream: mock_open_stream,
          srv_url: (run_id: string) =>
            `https://${String(opts.tenant)}.antithesis.com/run?run_id=${encodeURIComponent(run_id)}`
        }
      })
  }
})

// Mock the action's main function
const runMock = jest.spyOn(main, 'run')

// Mock the GitHub Actions core library
let infoMock: jest.SpyInstance
let errorMock: jest.SpyInstance
let warningMock: jest.SpyInstance
let getInputMock: jest.SpyInstance
let setOutputMock: jest.SpyInstance
let setFailedMock: jest.SpyInstance
let createCommitStatusMock: jest.Mock
let createCommentMock: jest.Mock
let updateCommentMock: jest.Mock
let listCommentsMock: jest.Mock
let pullsGetMock: jest.Mock
let reactionMock: jest.Mock
let watchMock: jest.SpyInstance

const default_inputs: Record<string, string> = {
  notebook_name: 'test_notebook_name',
  tenant: 'test_tenant',
  username: 'username',
  password: 'password',
  github_token: 'github_token',
  images: 'container1=sha1;container2=sha2;container3=sha3',
  config_image: 'config_container=sha4;',
  description: 'my description',
  test_name: 'test 1',
  email_recipients: 'myemail@mycompany.com;myfriendsemail@mycompany.com',
  additional_parameters: `
parameter1=value1
parameter2=value2
          `
}

function set_inputs(values: Record<string, string>): void {
  getInputMock.mockImplementation((name: string): string => values[name] ?? '')
}

/** The `--param` pairs of the one launch call, as an object. */
function launched_params(): Record<string, string> {
  expect(mock_launch).toHaveBeenCalledTimes(1)
  return mock_launch.mock.calls[0][1]
}

describe('main.run', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mock_client_options = undefined

    infoMock = jest.spyOn(core, 'info').mockImplementation()
    errorMock = jest.spyOn(core, 'error').mockImplementation()
    warningMock = jest.spyOn(core, 'warning').mockImplementation()
    jest.spyOn(core, 'setSecret').mockImplementation()
    getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
    set_inputs(default_inputs)
    setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
    setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()

    mock_launch.mockResolvedValue({ run_id: 'run-66-0', status_code: 202 })

    jest.spyOn(github.context, 'repo', 'get').mockImplementation(() => {
      return {
        owner: 'some-owner',
        repo: 'some-repo'
      }
    })
    github.context.eventName = 'push'
    github.context.actor = 'octocat'
    github.context.ref = 'refs/heads/some-ref'
    github.context.sha = '1234567890123456789012345678901234567890'
    github.context.payload = {
      repository: {
        name: 'repo_name',
        owner: { name: 'owner_name', login: 'owner_login' },
        statuses_url: 'https://where.to.post.status.com/sha1'
      }
    }

    createCommitStatusMock = jest.fn().mockResolvedValue({})
    createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } })
    updateCommentMock = jest.fn().mockResolvedValue({})
    listCommentsMock = jest.fn()
    pullsGetMock = jest.fn()
    reactionMock = jest.fn().mockResolvedValue({})
    jest.spyOn(github, 'getOctokit').mockReturnValue({
      paginate: jest.fn(async () => []),
      rest: {
        repos: { createCommitStatus: createCommitStatusMock },
        issues: {
          listComments: listCommentsMock,
          createComment: createCommentMock,
          updateComment: updateCommentMock
        },
        pulls: { get: pullsGetMock },
        reactions: { createForIssueComment: reactionMock }
      }
    } as unknown as ReturnType<typeof github.getOctokit>)

    watchMock = jest.spyOn(watcher, 'watch_run')
  })

  it('calls Antithesis through snouty with the historical parameter set', async () => {
    await main.run()
    expect(runMock).toHaveReturned()

    // When no api_key is set, fall back to basic auth.
    expect(mock_client_options).toMatchObject({
      binary: '/fake/snouty',
      tenant: 'test_tenant',
      credentials: { kind: 'basic', username: 'username', password: 'password' }
    })
    expect(mock_launch).toHaveBeenCalledWith(
      'test_notebook_name',
      expect.any(Object)
    )
    expect(launched_params()).toEqual({
      'run.creator_name': 'octocat',
      'run.caller_name': 'antithesis-trigger-action',
      'run.caller_type': 'github_action',
      'vcs.repo_type': 'github',
      'vcs.repo_owner': 'owner_login',
      'vcs.repo_name': 'repo_name',
      'vcs.repo_branch': 'some-ref',
      'vcs.version_id': '1234567890123456789012345678901234567890',
      'vcs.version_link':
        'https://github.com/some-owner/some-repo/commit/1234567890123456789012345678901234567890',
      'antithesis.integrations.type': 'github',
      'antithesis.integrations.callback_url':
        'https://where.to.post.status.com/sha11234567890123456789012345678901234567890',
      'antithesis.integrations.token': 'github_token',
      'antithesis.integrations.github.callback_url':
        'https://where.to.post.status.com/sha11234567890123456789012345678901234567890',
      'antithesis.integrations.github.token': 'github_token',
      'antithesis.images': 'container1=sha1;container2=sha2;container3=sha3',
      'antithesis.config_image': 'config_container=sha4;',
      'antithesis.source': 'some-ref',
      'antithesis.description': 'my description',
      'antithesis.report.recipients':
        'myemail@mycompany.com;myfriendsemail@mycompany.com',
      'antithesis.test_name': 'test 1',
      parameter1: 'value1',
      parameter2: 'value2'
    })

    expect(infoMock).toHaveBeenCalledWith('Source: some-ref')
    expect(infoMock).toHaveBeenCalledWith(
      `Additional Parameters: {"parameter1":"value1","parameter2":"value2"}`
    )

    // The pending status now links the single run view.
    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)
    expect(createCommitStatusMock).toHaveBeenCalledWith({
      owner: 'owner_name',
      repo: 'repo_name',
      sha: '1234567890123456789012345678901234567890',
      state: 'pending',
      description: 'Antithesis is running your tests.',
      context: 'continuous-testing/antithesis (test 1)',
      target_url: 'https://test_tenant.antithesis.com/run?run_id=run-66-0'
    })

    expect(setOutputMock).toHaveBeenCalledWith('run_id', 'run-66-0')
    expect(setOutputMock).toHaveBeenCalledWith(
      'run_url',
      'https://test_tenant.antithesis.com/run?run_id=run-66-0'
    )
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
    expect(watchMock).not.toHaveBeenCalled()
  })

  it('uses the api_key when set, in preference to username/password', async () => {
    set_inputs({ ...default_inputs, api_key: 'secret-api-key' })
    await main.run()
    expect(mock_client_options).toMatchObject({
      credentials: { kind: 'api_key', api_key: 'secret-api-key' }
    })
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('fails when neither api_key nor username/password are set', async () => {
    set_inputs({ notebook_name: 'test_notebook_name', tenant: 'test_tenant' })
    await main.run()
    expect(mock_launch).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Missing credentials: provide either `api_key`, or both `username` and `password`.'
    )
  })

  it('fails when only username (no password) is set', async () => {
    set_inputs({
      notebook_name: 'test_notebook_name',
      tenant: 'test_tenant',
      username: 'username'
    })
    await main.run()
    expect(mock_launch).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Missing credentials: provide either `api_key`, or both `username` and `password`.'
    )
  })

  it('calls Antithesis even when no callback url, without callback params or a status', async () => {
    github.context.payload = {
      repository: {
        name: 'repo_name',
        owner: { name: 'owner_name', login: 'owner_login' },
        statuses_url: undefined
      }
    }
    await main.run()
    expect(launched_params()).not.toHaveProperty([
      'antithesis.integrations.github.callback_url'
    ])
    expect(launched_params()).not.toHaveProperty([
      'antithesis.integrations.github.token'
    ])
    expect(infoMock).toHaveBeenCalledWith('Source: some-ref')
    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('calls Antithesis even when no ref specified', async () => {
    github.context.payload = {
      repository: {
        name: 'repo_name',
        owner: { name: 'owner_name', login: 'owner_login' },
        statuses_url: undefined
      }
    }
    github.context.ref = ''
    await main.run()
    expect(infoMock).toHaveBeenCalledWith('Source: ')
    expect(launched_params()['antithesis.source']).toBe('')
    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('calls Antithesis when repo owner name is not specified', async () => {
    github.context.payload = {
      repository: {
        name: 'repo_name',
        owner: { login: 'owner_name' },
        statuses_url: 'https://where.to.post.status.com/sha1'
      }
    }
    await main.run()
    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)
    expect(createCommitStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'owner_name' })
    )
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('reports the PR head commit to Antithesis on pull_request events', async () => {
    github.context.eventName = 'pull_request'
    github.context.ref = 'refs/pull/42/merge'
    github.context.payload = {
      ...github.context.payload,
      pull_request: {
        number: 42,
        html_url: 'https://github.com/o/r/pull/42',
        title: 'Fix',
        user: { login: 'author' },
        head: {
          sha: 'headsha',
          ref: 'feature',
          repo: { html_url: 'https://github.com/o/r' }
        }
      }
    }
    await main.run()
    expect(launched_params()).toMatchObject({
      'vcs.version_id': 'headsha',
      'vcs.version_link': 'https://github.com/o/r/commit/headsha',
      'vcs.pr_id': '42',
      'vcs.pr_link': 'https://github.com/o/r/pull/42',
      'vcs.pr_owner': 'author',
      'vcs.pr_title': 'Fix',
      'vcs.repo_branch': 'refs/pull/42/merge'
    })
    // Fire-and-forget still posts the status on the merge commit, as before.
    expect(createCommitStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ sha: github.context.sha })
    )
  })

  it('Handles Antithesis Non-2XX error code', async () => {
    mock_launch.mockRejectedValue(
      new ApiError('API error: 404 Not Found', 'not_found', 404)
    )
    await main.run()
    expect(setFailedMock).toHaveBeenCalledWith('API error: 404 Not Found')
    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
  })

  it('warns but still succeeds when posting commit status fails', async () => {
    createCommitStatusMock.mockRejectedValue(new Error('GitHub is down'))
    await main.run()
    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('GitHub is down')
    )
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('warns when the launch returns no run id but still succeeds', async () => {
    mock_launch.mockResolvedValue({ status_code: 202 })
    await main.run()
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining('run id'))
    expect(createCommitStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ target_url: undefined })
    )
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('Handles unexpected exceptions', async () => {
    mock_launch.mockRejectedValue(new Error('An unexpected exception.'))
    await main.run()
    expect(errorMock).toHaveBeenCalledWith(
      'Failed to submit request : An unexpected exception.'
    )
    expect(setFailedMock).toHaveBeenCalledWith('An unexpected exception.')
    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
  })

  describe('comment mode', () => {
    const pr_payload = {
      repository: {
        name: 'repo_name',
        owner: { name: 'owner_name', login: 'owner_login' },
        statuses_url: 'https://where.to.post.status.com/sha1'
      },
      pull_request: {
        number: 42,
        html_url: 'https://github.com/o/r/pull/42',
        title: 'Fix',
        user: { login: 'author' },
        head: {
          sha: 'headsha',
          ref: 'feature',
          repo: { html_url: 'https://github.com/o/r' }
        }
      }
    }

    beforeEach(() => {
      set_inputs({
        ...default_inputs,
        username: '',
        password: '',
        api_key: 'key',
        mode: 'comment'
      })
      github.context.eventName = 'pull_request'
      github.context.ref = 'refs/pull/42/merge'
      github.context.payload = pr_payload
      watchMock.mockResolvedValue({
        kind: 'completed',
        snapshot: {
          failing: [],
          failing_count: 1,
          passing_count: 9,
          undetermined_count: 0,
          fetched_at: 0
        }
      })
    })

    it('posts the initial comment and status, watches, and reports the outcome', async () => {
      await main.run()

      // No server-side callback: the action owns the commit status.
      expect(launched_params()).not.toHaveProperty([
        'antithesis.integrations.github.token'
      ])
      expect(launched_params()).toMatchObject({
        'vcs.repo_branch': 'feature',
        'antithesis.source': 'feature'
      })

      expect(createCommentMock).toHaveBeenCalledTimes(1)
      expect(createCommentMock.mock.calls[0][0]).toMatchObject({
        issue_number: 42
      })
      expect(createCommentMock.mock.calls[0][0].body).toContain('Launching')
      expect(createCommitStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sha: 'headsha',
          state: 'pending',
          target_url: 'https://test_tenant.antithesis.com/run?run_id=run-66-0'
        })
      )
      expect(watchMock).toHaveBeenCalledTimes(1)
      expect(watchMock.mock.calls[0][1]).toMatchObject({
        run_id: 'run-66-0',
        poll_interval_ms: 30_000,
        update_interval_ms: 60_000,
        view: {
          marker_key: 'test 1',
          title: 'test 1',
          commit_sha: 'headsha',
          max_failures: 25
        }
      })
      expect(setOutputMock).toHaveBeenCalledWith('status', 'completed')
      expect(setOutputMock).toHaveBeenCalledWith('passing', '9')
      expect(setOutputMock).toHaveBeenCalledWith('failing', '1')
      expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
      expect(setFailedMock).not.toHaveBeenCalled()
    })

    it.each([
      [
        { kind: 'run_failed', status: 'incomplete', failure_reason: 'boom' },
        /ended as incomplete: boom/
      ],
      [
        { kind: 'api_error', message: 'the run never became visible' },
        /never became visible/
      ]
    ])('fails the job for %o', async (outcome, pattern) => {
      watchMock.mockResolvedValue(outcome)
      await main.run()
      expect(setOutputMock).toHaveBeenCalledWith('result', 'Failed')
      expect(setFailedMock).toHaveBeenCalledWith(expect.stringMatching(pattern))
    })

    it.each([{ kind: 'timed_out' }, { kind: 'aborted' }])(
      'stays green for %o',
      async outcome => {
        watchMock.mockResolvedValue(outcome)
        await main.run()
        expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
        expect(setFailedMock).not.toHaveBeenCalled()
      }
    )

    it('fails when the launch returns no run id', async () => {
      mock_launch.mockResolvedValue({ status_code: 202 })
      await main.run()
      expect(watchMock).not.toHaveBeenCalled()
      expect(createCommentMock.mock.calls[0][0].body).toContain(
        'Results unavailable'
      )
      expect(createCommitStatusMock).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'error' })
      )
      expect(setFailedMock).toHaveBeenCalledWith(
        expect.stringContaining('no run id')
      )
    })

    it('downgrades to fire-and-forget with basic auth', async () => {
      set_inputs({ ...default_inputs, mode: 'comment' })
      await main.run()
      expect(warningMock).toHaveBeenCalledWith(
        expect.stringContaining('fire-and-forget')
      )
      expect(watchMock).not.toHaveBeenCalled()
      expect(launched_params()).toHaveProperty([
        'antithesis.integrations.github.token'
      ])
    })

    it('runs for an /antithesis comment, reacting and resolving the PR head', async () => {
      set_inputs({
        ...default_inputs,
        username: '',
        password: '',
        api_key: 'key'
      })
      github.context.eventName = 'issue_comment'
      github.context.payload = {
        repository: pr_payload.repository,
        issue: { number: 42, pull_request: { url: 'x' } },
        comment: { id: 777, body: '/antithesis' }
      }
      pullsGetMock.mockResolvedValue({
        data: {
          head: {
            sha: 'headsha',
            ref: 'feature',
            repo: { html_url: 'https://github.com/o/r' }
          },
          html_url: 'https://github.com/o/r/pull/42',
          title: 'Fix',
          user: { login: 'author' }
        }
      })
      await main.run()
      expect(pullsGetMock).toHaveBeenCalledWith({
        owner: 'owner_name',
        repo: 'repo_name',
        pull_number: 42
      })
      expect(reactionMock).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 777, content: 'eyes' })
      )
      expect(launched_params()).toMatchObject({
        'vcs.version_id': 'headsha',
        'vcs.pr_id': '42'
      })
      expect(watchMock).toHaveBeenCalledTimes(1)
    })

    it('skips an issue comment that is not an /antithesis command', async () => {
      github.context.eventName = 'issue_comment'
      github.context.payload = {
        repository: pr_payload.repository,
        issue: { number: 42, pull_request: { url: 'x' } },
        comment: { id: 777, body: 'LGTM' }
      }
      await main.run()
      expect(mock_launch).not.toHaveBeenCalled()
      expect(setOutputMock).toHaveBeenCalledWith('result', 'Skipped')
      expect(setFailedMock).not.toHaveBeenCalled()
    })
  })
})
