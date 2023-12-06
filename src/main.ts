import * as core from '@actions/core'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const notebook_name: string = core.getInput('notebook_name')

    core.info(`Notebook to Run: ${notebook_name}`)

    core.setOutput('result', 'Success')
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
