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
import axios from 'axios'

// Mock the action's main function
const runMock = jest.spyOn(main, 'run')

// Mock the GitHub Actions core library
let infoMock: jest.SpyInstance
let errorMock: jest.SpyInstance
let getInputMock: jest.SpyInstance
let setOutputMock: jest.SpyInstance
let setFailedMock: jest.SpyInstance
let axiosMock: jest.SpyInstance
let createCommitStatusMock: jest.Mock

describe('reasonable_pr_info', () => {
  it('undefined context.payload.pull_request returns {}', async () => {
    github.context.payload.pull_request = undefined
    expect(main.get_pr_info()).toEqual({})
  })

  it("mostly-empty payload.pull_request doesn't override commit info", async () => {
    github.context.payload.pull_request = { number: 1 }
    const pr_info = main.get_pr_info()
    expect(pr_info).not.toHaveProperty(['vcs.version_id'])
    expect(pr_info).not.toHaveProperty(['vcs.version_link'])
  })

  it('payload.pull_request overrides commit info if possible', async () => {
    github.context.payload.pull_request = {
      head: {
        sha: 'deadbeef',
        repo: {
          html_url: 'https://github.com'
        }
      },
      number: 1
    }
    const pr_info = main.get_pr_info()
    expect(pr_info).toHaveProperty(['vcs.version_id'])
    expect(pr_info).toHaveProperty(['vcs.version_link'])
  })
})

describe('successful_action', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    infoMock = jest.spyOn(core, 'info').mockImplementation()
    errorMock = jest.spyOn(core, 'error').mockImplementation()

    getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
    getInputMock.mockImplementation((name: string): string => {
      switch (name) {
        case 'notebook_name':
          return 'test_notebook_name'
        case 'tenant':
          return 'test_tenant'
        case 'username':
          return 'username'
        case 'password':
          return 'password'
        case 'github_token':
          return 'github_token'
        case 'images':
          return 'container1=sha1;container2=sha2;container3=sha3'
        case 'config_image':
          return 'config_container=sha4;'
        case 'description':
          return 'my description'
        case 'test_name':
          return 'test 1'
        case 'email_recipients':
          return 'myemail@mycompany.com;myfriendsemail@mycompany.com'
        case 'additional_parameters':
          return `
parameter1=value1
parameter2=value2
          `
        default:
          return ''
      }
    })

    setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
    setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
    axiosMock = jest.spyOn(axios, 'post').mockImplementation()

    jest.spyOn(github.context, 'repo', 'get').mockImplementation(() => {
      return {
        owner: 'some-owner',
        repo: 'some-repo'
      }
    })
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
    jest.spyOn(github, 'getOctokit').mockReturnValue({
      rest: { repos: { createCommitStatus: createCommitStatusMock } }
    } as unknown as ReturnType<typeof github.getOctokit>)
  })

  it('calls Antithesis', async () => {
    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    // Validate callback is called correctly
    expect(axiosMock).toHaveBeenCalled()

    // When no api_key is set, fall back to basic auth.
    const [, , request_config] = axiosMock.mock.calls[0]
    expect(request_config).toEqual({
      auth: { username: 'username', password: 'password' }
    })

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request Url:https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Callback Url: https://where.to.post.status.com/sha11234567890123456789012345678901234567890'
    )

    expect(infoMock).toHaveBeenNthCalledWith(
      7,
      `Additional Parameters: {"parameter1":"value1","parameter2":"value2"}`
    )

    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('uses Bearer auth when api_key is set', async () => {
    getInputMock.mockImplementation((name: string): string => {
      switch (name) {
        case 'notebook_name':
          return 'test_notebook_name'
        case 'tenant':
          return 'test_tenant'
        case 'api_key':
          return 'secret-api-key'
        case 'github_token':
          return 'github_token'
        default:
          return ''
      }
    })

    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    expect(axiosMock).toHaveBeenCalled()

    // api_key takes precedence and is sent as a Bearer header; no basic auth.
    const [, , request_config] = axiosMock.mock.calls[0]
    expect(request_config).toEqual({
      headers: { Authorization: 'Bearer secret-api-key' }
    })

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('prefers api_key over username/password when both are set', async () => {
    getInputMock.mockImplementation((name: string): string => {
      switch (name) {
        case 'notebook_name':
          return 'test_notebook_name'
        case 'tenant':
          return 'test_tenant'
        case 'username':
          return 'username'
        case 'password':
          return 'password'
        case 'api_key':
          return 'secret-api-key'
        case 'github_token':
          return 'github_token'
        default:
          return ''
      }
    })

    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    const [, , request_config] = axiosMock.mock.calls[0]
    expect(request_config).toEqual({
      headers: { Authorization: 'Bearer secret-api-key' }
    })
    expect(request_config).not.toHaveProperty('auth')
  })

  it('fails when neither api_key nor username/password are set', async () => {
    getInputMock.mockImplementation((name: string): string => {
      switch (name) {
        case 'notebook_name':
          return 'test_notebook_name'
        case 'tenant':
          return 'test_tenant'
        default:
          return ''
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    expect(axiosMock).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Missing credentials: provide either `api_key`, or both `username` and `password`.'
    )
  })

  it('fails when only username (no password) is set', async () => {
    getInputMock.mockImplementation((name: string): string => {
      switch (name) {
        case 'notebook_name':
          return 'test_notebook_name'
        case 'tenant':
          return 'test_tenant'
        case 'username':
          return 'username'
        default:
          return ''
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    expect(axiosMock).not.toHaveBeenCalled()
    expect(setFailedMock).toHaveBeenCalledWith(
      'Missing credentials: provide either `api_key`, or both `username` and `password`.'
    )
  })

  it('calls Antithesis even when no callback url', async () => {
    github.context.payload = {
      repository: {
        name: 'repo_name',
        owner: { name: 'owner_name', login: 'owner_login' },
        statuses_url: undefined
      }
    }

    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    // Validate callback is called correctly
    expect(axiosMock).toHaveBeenCalled()

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request Url:https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(infoMock).toHaveBeenNthCalledWith(2, 'Callback Url: undefined')

    expect(infoMock).toHaveBeenNthCalledWith(6, 'Source: some-ref')

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

    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })

    await main.run()
    expect(runMock).toHaveReturned()

    // Validate callback is called correctly
    expect(axiosMock).toHaveBeenCalled()

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request Url:https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(infoMock).toHaveBeenNthCalledWith(2, 'Callback Url: undefined')

    expect(infoMock).toHaveBeenNthCalledWith(6, 'Source: ')

    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('calls Antithesis when repo owner name is not specified', async () => {
    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })

    github.context.payload = {
      repository: {
        name: 'repo_name',
        owner: { login: 'owner_name' },
        statuses_url: 'https://where.to.post.status.com/sha1'
      }
    }

    await main.run()
    expect(runMock).toHaveReturned()

    // Validate callback is called correctly
    expect(axiosMock).toHaveBeenCalled()

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request Url:https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Callback Url: https://where.to.post.status.com/sha11234567890123456789012345678901234567890'
    )

    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('Handles Antithesis Non-2XX error code', async () => {
    // Axios throws on non-2XX responses by default; the action lets the
    // exception propagate to the outer catch.
    axiosMock.mockImplementation(() => {
      throw new Error('Request failed with status code 404')
    })

    await main.run()
    expect(runMock).toHaveReturned()

    // Validate callback is called correctly
    expect(axiosMock).toHaveBeenCalled()

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request Url:https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Callback Url: https://where.to.post.status.com/sha11234567890123456789012345678901234567890'
    )

    expect(setFailedMock).toHaveBeenCalledWith(
      'Request failed with status code 404'
    )

    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
  })

  it('logs an error but still succeeds when posting commit status fails', async () => {
    axiosMock.mockImplementation(() => {
      return {
        status: 202
      }
    })
    createCommitStatusMock.mockRejectedValue(new Error('GitHub is down'))

    await main.run()
    expect(runMock).toHaveReturned()

    expect(axiosMock).toHaveBeenCalled()
    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)

    // The commit-status failure is non-fatal: it logs an error...
    expect(errorMock).toHaveBeenCalledWith(
      'Failed to post a pending status on GitHub due to Error: GitHub is down'
    )

    // ...but the action still reports success and does not fail.
    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
    expect(setFailedMock).not.toHaveBeenCalled()
  })

  it('Handles unexpected exceptions', async () => {
    axiosMock.mockImplementation(() => {
      throw new Error('An unexpected exception.')
    })

    await main.run()
    expect(runMock).toHaveReturned()

    // Validate callback is called correctly
    expect(axiosMock).toHaveBeenCalled()

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request Url:https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Callback Url: https://where.to.post.status.com/sha11234567890123456789012345678901234567890'
    )

    expect(errorMock).toHaveBeenNthCalledWith(
      1,
      'Failed to submit request : An unexpected exception.'
    )

    expect(setFailedMock).toHaveBeenCalledWith('An unexpected exception.')

    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
  })
})
