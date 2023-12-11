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

    const github_token = core.getInput('github_token')

    const statuses_url = context?.payload?.repository?.statuses_url
    core.info(`Statuses_url: ${statuses_url}`)

    const commit_sha = context?.payload?.sha
    core.info(`Sha: ${commit_sha}`)

    const call_back_url =
      statuses_url !== undefined && commit_sha !== undefined
        ? statuses_url.replace('{sha}', '')
        : undefined

    core.info(`Callback URL: ${call_back_url}`)

    const body = `antithesis.integrations.call_back_url=${call_back_url}&antithesis.integrations.token=${github_token}`

    const result = await axios.post(url, body, {
      auth: {
        username,
        password
      }
    })

    core.info(`Successfully sent the request ${result}`)
    core.setOutput('result', 'Success')
  } catch (error) {
    core.error(`Failed to submit request : ${error}`)
    if (error instanceof Error) core.setFailed(error.message)
  }
}
