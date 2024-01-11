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
let createCommitStatusMock: jest.SpyInstance

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
          return ''
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

    createCommitStatusMock = jest
      .spyOn(github, 'getOctokit')
      .mockImplementation()
  })

  it('calls Anithesis', async () => {
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

    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Callback Url: https://where.to.post.status.com/sha11234567890123456789012345678901234567890'
    )

    expect(createCommitStatusMock).toHaveBeenCalledTimes(1)

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('calls Anithesis even when no callback url', async () => {
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

    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })

  it('calls Anithesis when repo owner name is not specified', async () => {
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

  it('Handles Anithesis Non-2XX error code', async () => {
    axiosMock.mockImplementation(() => {
      return {
        status: 404
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

    expect(infoMock).toHaveBeenNthCalledWith(
      2,
      'Callback Url: https://where.to.post.status.com/sha11234567890123456789012345678901234567890'
    )

    expect(setFailedMock).toHaveBeenCalledWith(
      'Failed to submit request, recieved a non-2XX response code : 404'
    )

    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
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
      'Failed to submit request : Error: An unexpected exception.'
    )

    expect(setFailedMock).toHaveBeenCalledWith('An unexpected exception.')

    expect(createCommitStatusMock).toHaveBeenCalledTimes(0)
  })
})
