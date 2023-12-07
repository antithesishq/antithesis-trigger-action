import { context } from '@actions/github'
import * as core from '@actions/core'
import axios from 'axios'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const tenant: string = core.getInput('tenant')
    const notebook_name: string = core.getInput('notebook_name')

    const url = `https://${tenant}.antithesis.com/api/v1/launch_experiment/${notebook_name}`

    core.info(`Request :${url}`)

    const username = core.getInput('username')
    const password = core.getInput('password')

    core.info(JSON.stringify(context))

    const result = await axios.post(
      url,
      {},
      {
        auth: {
          username,
          password
        }
      }
    )

    core.info(`Successfully sent the request ${result}`)
    core.setOutput('result', 'Success')
  } catch (error) {
    core.error(`Failed to submit request : ${error}`)
    if (error instanceof Error) core.setFailed(error.message)
  }
}
