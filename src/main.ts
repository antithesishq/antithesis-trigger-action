import { context, getOctokit } from '@actions/github'
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
    const github_token = core.getInput('github_token')
    const images = core.getInput('images')

    const statuses_url = context?.payload?.repository?.statuses_url
    const sha = context?.sha
    const call_back_url =
      statuses_url !== undefined && sha !== undefined
        ? `${statuses_url.replace('{sha}', '')}${sha}`
        : undefined

    core.info(`Callback URL: ${call_back_url}`)

    const body = `antithesis.integrations.call_back_url=${call_back_url}&antithesis.integrations.token=${github_token}&antithesis.containers=${images}`

    const result = await axios.post(url, body, {
      auth: {
        username,
        password
      }
    })

    const owner = context?.payload?.repository?.owner?.name
    const repo = context?.payload?.repository?.name

    try {
      const octokit = getOctokit(github_token)

      if (owner && repo && sha) {
        octokit.rest.repos.createCommitStatus({
          owner,
          repo,
          sha,
          state: 'pending',
          description: 'Antithesis is running your tests.',
          context: 'continuous-testing/antithesis'
        })
      }
    } catch (error) {
      core.error(`Failed to post a pending status on GitHub due to ${error}`)
    }

    core.info(`Successfully sent the request ${result}`)
    core.setOutput('result', 'Success')
  } catch (error) {
    core.error(`Failed to submit request : ${error}`)
    if (error instanceof Error) core.setFailed(error.message)
  }
}
