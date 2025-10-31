import { context, getOctokit } from '@actions/github'
import * as core from '@actions/core'
import type { PullRequest } from '@octokit/webhooks-definitions/schema'
import axios from 'axios'

function parse_parts(
  line: string
): { name: string; value: string } | undefined {
  if (!line) return undefined

  const parts = line?.trim().split('=')

  if (parts && parts.length < 2) {
    core.warning(
      `These parameters could not be parsed and will not be sent to the webhook: ${line}`
    )
    return undefined
  }

  const [name, ...rest] = parts
  const value = rest.join('=')
  return { name: name.trim(), value: value.trim() }
}

export function parse_additional_parameters(
  params_string: string
): Record<string, string> {
  const result: Record<string, string> = {}

  if (params_string) {
    for (const line of params_string.split(/\r|\n/)) {
      const parts = parse_parts(line)
      if (parts != null) {
        result[parts.name] = parts.value
      }
    }
  }
  return result
}

const THIS_ACTION = 'antithesis-trigger-action'

type CommitInfo = {
  'vcs.version_id': string
  'vcs.version_link': string
}

export function get_commit_info(): CommitInfo | Record<string, never> {
  const commit_link = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/commit/${context.sha}`
  return {
    'vcs.version_id': context.sha,
    'vcs.version_link': commit_link
  }
}

type PRInfo = {
  'vcs.pr_link': string
  'vcs.pr_id': number
  'vcs.pr_title': string
  'vcs.pr_owner': string
}

export function get_pr_info(): (PRInfo & CommitInfo) | Record<string, never> {
  const pr = context?.payload.pull_request as PullRequest | undefined
  if (pr === undefined) {
    core.info('The event that invoked this Action has no `pull_request`.')
    return {}
  }
  // Override `get_commit_info()`: we only care about the feature commit.
  return {
    'vcs.version_id': pr.head.sha,
    'vcs.version_link': `${pr.head.repo.html_url}/commit/${pr.head.sha}`,
    'vcs.pr_link': pr.html_url,
    'vcs.pr_id': pr.number,
    'vcs.pr_title': pr.title,
    'vcs.pr_owner': pr.user.login
  }
}

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

    const callback_url =
      statuses_url !== undefined && sha !== undefined
        ? `${statuses_url.replace('{sha}', '')}${sha}`
        : undefined

    core.info(`Callback Url: ${callback_url}`)

    // Read images information
    const images = core.getInput('images')
    const config_image = core.getInput('config_image')

    core.info(`Images: ${images}`)
    core.info(`Config Image: ${config_image}`)

    // Read description information

    const description = core.getInput('description')

    core.info(`Desc: ${description}`)

    // Build the request body
    const github_token = core.getInput('github_token')

    // Extract the branch
    // (nb: the ref may be a branch *or a tag!*)
    const branch = context.ref?.replace('refs/heads/', '') ?? ''

    core.info(`Source: ${branch}`)

    // Extract email list
    const emails = core.getInput('email_recipients')

    const additional_parameters = parse_additional_parameters(
      core.getInput('additional_parameters')
    )

    core.info(`Additional Parameters: ${JSON.stringify(additional_parameters)}`)

    const test_name = core.getInput('test_name')

    const body = {
      params: {
        'run.creator_name': context?.actor,
        'run.team': core.getInput('team'),
        'run.cron_schedule': core.getInput('cron_schedule'),
        'run.caller_name': THIS_ACTION,
        'run.caller_type': 'github_action',
        'vcs.system_name': core.getInput('system_name'),
        'vcs.repo_type': 'github',
        'vcs.repo_owner': context?.payload.repository?.owner.login,
        'vcs.repo_name': context?.payload.repository?.name,
        'vcs.repo_branch': branch,

        ...get_commit_info(),
        ...get_pr_info(),

        // these are deprecated:
        //'antithesis.integrations.type': 'github',
        //'antithesis.integrations.callback_url': callback_url,
        //'antithesis.integrations.token': github_token,

        // these aren't:
        'antithesis.integrations.github.callback_url': callback_url,
        'antithesis.integrations.github.token': github_token,

        'antithesis.images': images,
        'antithesis.config_image': config_image,
        'antithesis.source': branch,
        'antithesis.description': description,
        'antithesis.report.recipients': emails,
        'antithesis.test_name': test_name,
        ...additional_parameters
      }
    }

    // Call into Antithesis
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
    // Only if we have a callback URL & a token, because we want to make sure
    // that Antithesis could update the status to done
    if (callback_url !== undefined && github_token !== undefined) {
      let owner = context?.payload?.repository?.owner?.name
      if (owner === undefined) {
        owner = context?.payload?.repository?.owner?.login
      }

      const repo = context?.payload?.repository?.name

      try {
        const octokit = getOctokit(github_token)

        const status_context =
          test_name !== undefined && test_name.length > 0
            ? `continuous-testing/antithesis (${test_name})`
            : 'continuous-testing/antithesis'

        if (owner && repo && sha) {
          octokit.rest.repos.createCommitStatus({
            owner,
            repo,
            sha,
            state: 'pending',
            description: 'Antithesis is running your tests.',
            context: status_context
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
