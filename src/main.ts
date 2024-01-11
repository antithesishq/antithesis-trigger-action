import { context, getOctokit } from '@actions/github'
import * as core from '@actions/core'
import axios from 'axios'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Build the request URL
    const tenant: string = core.getInput('tenant')
    const notebook_name: string = core.getInput('notebook_name')

    const url = `https://${tenant}.antithesis.com/api/v1/launch_experiment/${notebook_name}`

    core.info(`Request Url:${url}`)

    // Build the Callback URL
    const statuses_url = context?.payload?.repository?.statuses_url
    const sha = context?.sha

    const call_back_url =
      statuses_url !== undefined && sha !== undefined
        ? `${statuses_url.replace('{sha}', '')}${sha}`
        : undefined

    core.info(`Callback Url: ${call_back_url}`)

    // Build the request body
    const github_token = core.getInput('github_token')
    const images = core.getInput('images')

    const body = {
      params: {
        'antithesis.integrations.type': 'github',
        'antithesis.integrations.call_back_url': call_back_url,
        'antithesis.integrations.token': github_token,
        'antithesis.images': images
      }
    }

    // Call into Anithesis
    const username = core.getInput('username')
    const password = core.getInput('password')

    const result = await axios.post(url, body, {
      auth: {
        username,
        password
      }
    })

    if (result.status < 200 || result.status >= 300) {
      const msg = `Failed to submit request, recieved a non-2XX response code : ${result.status}`
      core.error(msg)
      core.setFailed(msg)
      return
    }

    // Update GitHub commit status with pending status
    // Only if we have a call back URL & a token , because we want to make sure
    // that Antithesis could update the status to done
    if (call_back_url !== undefined && github_token !== undefined) {
      const owner = context?.payload?.repository?.owner?.name
      const repo = context?.payload?.repository?.name

      try {
        const octokit = getOctokit(github_token)

        core.info(`Context: ${JSON.stringify(context)}`)

        core.info(`Owner: ${owner}`)
        core.info(`Repo: ${repo}`)
        core.info(`Sha: ${sha}`)

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

        // this is a non-fatal error so we are ok if we miss this step
      }
    }
    // Set status to success
    core.info(`Successfully sent the request ${result}`)
    core.setOutput('result', 'Success')
  } catch (error) {
    core.error(`Failed to submit request : ${error}`)
    if (error instanceof Error) core.setFailed(error.message)
  }
}
