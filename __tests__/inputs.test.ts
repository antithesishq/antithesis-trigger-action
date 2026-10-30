import * as core from '@actions/core'
import {
  INPUT_DEFAULTS,
  MISSING_CREDENTIALS_MESSAGE,
  read_inputs
} from '../src/inputs'
import { DEFAULT_SNOUTY_VERSION } from '../src/snouty-install'

function with_inputs(values: Record<string, string>): void {
  jest
    .spyOn(core, 'getInput')
    .mockImplementation((name: string) => values[name] ?? '')
}

describe('read_inputs', () => {
  let setSecretMock: jest.SpyInstance
  let warningMock: jest.SpyInstance

  beforeEach(() => {
    jest.spyOn(core, 'info').mockImplementation()
    warningMock = jest.spyOn(core, 'warning').mockImplementation()
    setSecretMock = jest.spyOn(core, 'setSecret').mockImplementation()
  })

  it('prefers the api key and masks every credential', () => {
    with_inputs({
      api_key: 'k',
      username: 'u',
      password: 'p',
      github_token: 't',
      tenant: 'ten',
      notebook_name: 'nb'
    })
    const inputs = read_inputs({})
    expect(inputs.credentials).toEqual({ kind: 'api_key', api_key: 'k' })
    for (const secret of ['k', 'u', 'p', 't']) {
      expect(setSecretMock).toHaveBeenCalledWith(secret)
    }
  })

  it('falls back to basic auth', () => {
    with_inputs({ username: 'u', password: 'p' })
    expect(read_inputs({}).credentials).toEqual({
      kind: 'basic',
      username: 'u',
      password: 'p'
    })
  })

  it('uses OIDC when the workflow exposes a token and nothing else is set', () => {
    with_inputs({})
    const inputs = read_inputs({
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req'
    })
    expect(inputs.credentials).toEqual({ kind: 'oidc' })
  })

  it('fails without any credential, with the historical message', () => {
    with_inputs({ username: 'only-a-username' })
    expect(() => read_inputs({})).toThrow(MISSING_CREDENTIALS_MESSAGE)
  })

  it('applies the defaults', () => {
    with_inputs({ api_key: 'k' })
    const inputs = read_inputs({})
    expect(inputs.mode).toBe('fire-and-forget')
    expect(inputs.poll_interval_ms).toBe(INPUT_DEFAULTS.poll_interval_ms)
    expect(inputs.update_interval_ms).toBe(INPUT_DEFAULTS.update_interval_ms)
    expect(inputs.wait_timeout_ms).toBe(INPUT_DEFAULTS.wait_timeout_ms)
    expect(inputs.comment_max_failures).toBe(
      INPUT_DEFAULTS.comment_max_failures
    )
    expect(inputs.snouty_version).toBe(DEFAULT_SNOUTY_VERSION)
    expect(inputs.additional_parameters).toEqual({})
  })

  it('parses durations and clamps the poll interval to the minimum', () => {
    with_inputs({
      api_key: 'k',
      poll_interval: '5s',
      update_interval: '2m',
      wait_timeout: '0',
      comment_max_failures: '3'
    })
    const inputs = read_inputs({})
    expect(inputs.poll_interval_ms).toBe(INPUT_DEFAULTS.min_poll_interval_ms)
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('poll_interval')
    )
    expect(inputs.update_interval_ms).toBe(120_000)
    expect(inputs.wait_timeout_ms).toBe(0)
    expect(inputs.comment_max_failures).toBe(3)
  })

  it('accepts mode comment and rejects anything else', () => {
    with_inputs({ api_key: 'k', mode: 'comment' })
    expect(read_inputs({}).mode).toBe('comment')
    with_inputs({ api_key: 'k', mode: 'loud' })
    expect(() => read_inputs({})).toThrow(/Invalid mode "loud"/)
  })

  it('parses additional parameters', () => {
    with_inputs({ api_key: 'k', additional_parameters: 'a=1\nb=2=3' })
    expect(read_inputs({}).additional_parameters).toEqual({
      a: '1',
      b: '2=3'
    })
  })
})
