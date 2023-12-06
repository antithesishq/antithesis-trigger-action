/**
 * Unit tests for the action's main functionality, src/main.ts
 *
 * These should be run as if the action was called from a workflow.
 * Specifically, the inputs listed in `action.yml` should be set as environment
 * variables following the pattern `INPUT_<INPUT_NAME>`.
 */

import * as core from '@actions/core'
import * as main from '../src/main'
import axios from 'axios'

// Mock the action's main function
const runMock = jest.spyOn(main, 'run')

// Mock the GitHub Actions core library
let infoMock: jest.SpyInstance
let getInputMock: jest.SpyInstance
let setOutputMock: jest.SpyInstance
let axiosMock: jest.SpyInstance

describe('action', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    infoMock = jest.spyOn(core, 'info').mockImplementation()
    getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
    setOutputMock = jest.spyOn(core, 'setOutput').mockImplementation()
    axiosMock = jest.spyOn(axios, 'post').mockImplementation()
  })

  it('sets the notebook name', async () => {
    // Set the action's inputs as return values from core.getInput()
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
        default:
          return ''
      }
    })

    axiosMock.mockImplementation(() => {
      return
    })

    await main.run()
    expect(runMock).toHaveReturned()

    // Verify that all of the core library functions were called correctly
    expect(infoMock).toHaveBeenNthCalledWith(
      1,
      'Request :https://test_tenant.antithesis.com/api/v1/launch_experiment/test_notebook_name'
    )

    expect(setOutputMock).toHaveBeenCalledWith('result', 'Success')
  })
})
