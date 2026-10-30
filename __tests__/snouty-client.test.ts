import * as fc from 'fast-check'
import {
  ApiError,
  classify_snouty_error,
  parse_stream_line,
  SnoutyClient,
  type ProcessEvent,
  type SpawnOptions,
  type SpawnResult,
  type Spawner
} from '../src/snouty-client'

/** A spawner that records every call and answers from a script. */
class FakeSpawner implements Spawner {
  calls: Array<{ args: string[]; opts: SpawnOptions }> = []
  next_result: SpawnResult = { code: 0, stdout: '', stderr: '' }
  stream_events: ProcessEvent[] = []

  async run(
    _cmd: string,
    args: string[],
    opts: SpawnOptions
  ): Promise<SpawnResult> {
    this.calls.push({ args, opts })
    return this.next_result
  }

  async *stream(
    _cmd: string,
    args: string[],
    opts: SpawnOptions & { signal: AbortSignal }
  ): AsyncIterable<ProcessEvent> {
    this.calls.push({ args, opts })
    for (const event of this.stream_events) {
      if (opts.signal.aborted) return
      yield event
    }
  }
}

function client(
  spawner: FakeSpawner,
  credentials: SnoutyClient['opts']['credentials'] = {
    kind: 'api_key',
    api_key: 'secret-key'
  },
  base_env: NodeJS.ProcessEnv = {
    PATH: '/bin',
    ANTITHESIS_API_KEY: 'from-runner',
    ANTITHESIS_TENANT: 'wrong'
  }
): SnoutyClient {
  return new SnoutyClient({
    binary: '/opt/snouty',
    tenant: 'acme',
    credentials,
    cwd: '/tmp/empty',
    spawner,
    base_env
  })
}

describe('SnoutyClient environment', () => {
  it('sets the tenant and the API key, dropping ANTITHESIS_* from the runner', () => {
    const env = client(new FakeSpawner()).env()
    expect(env).toEqual({
      PATH: '/bin',
      ANTITHESIS_TENANT: 'acme',
      ANTITHESIS_API_KEY: 'secret-key'
    })
  })

  it('passes basic auth through the deprecated variables', () => {
    const env = client(new FakeSpawner(), {
      kind: 'basic',
      username: 'u',
      password: 'p'
    }).env()
    expect(env).toMatchObject({
      ANTITHESIS_USERNAME: 'u',
      ANTITHESIS_PASSWORD: 'p'
    })
    expect(env).not.toHaveProperty('ANTITHESIS_API_KEY')
  })

  it('leaves the OIDC request variables for snouty to use', () => {
    const env = client(
      new FakeSpawner(),
      { kind: 'oidc' },
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://t',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r'
      }
    ).env()
    expect(env).toEqual({
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://t',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'r',
      ANTITHESIS_TENANT: 'acme'
    })
  })

  it('builds the single run view URL', () => {
    expect(client(new FakeSpawner()).srv_url('abc-66-0/x')).toBe(
      'https://acme.antithesis.com/run?run_id=abc-66-0%2Fx'
    )
  })
})

describe('SnoutyClient.launch', () => {
  it('passes every parameter as --param and never uses snouty’s own vcs detection', async () => {
    const spawner = new FakeSpawner()
    spawner.next_result = {
      code: 0,
      stdout: '{"statusCode":202,"runId":"r-66-0"}\n',
      stderr: ''
    }
    const result = await client(spawner).launch('my_nb', {
      'run.caller_type': 'github_action',
      'antithesis.images': 'a;b',
      'antithesis.integrations.github.token': 'tok'
    })
    expect(result).toEqual({ run_id: 'r-66-0', status_code: 202 })
    const { args, opts } = spawner.calls[0]
    expect(args.slice(0, 5)).toEqual([
      '--json',
      'launch',
      '--launcher',
      'my_nb',
      '--no-vcs'
    ])
    expect(args.slice(5)).toEqual([
      '--param',
      'run.caller_type=github_action',
      '--param',
      'antithesis.images=a;b',
      '--param',
      'antithesis.integrations.github.token=tok'
    ])
    expect(opts.cwd).toBe('/tmp/empty')
  })

  it('tolerates a missing run id', async () => {
    const spawner = new FakeSpawner()
    spawner.next_result = { code: 0, stdout: '{"statusCode":202}', stderr: '' }
    expect(await client(spawner).launch('nb', {})).toEqual({
      run_id: undefined,
      status_code: 202
    })
  })

  it('reports non-JSON output and failures as ApiError', async () => {
    const spawner = new FakeSpawner()
    spawner.next_result = { code: 0, stdout: 'not json', stderr: '' }
    await expect(client(spawner).launch('nb', {})).rejects.toMatchObject({
      code: 'other'
    })
    spawner.next_result = {
      code: 1,
      stdout: '',
      stderr: 'launching\nError: API error: 402 usage cap reached'
    }
    await expect(client(spawner).launch('nb', {})).rejects.toMatchObject({
      code: 'other',
      status: 402,
      message: 'API error: 402 usage cap reached'
    })
  })

  it('never puts the command line into the error', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 8 }), async token => {
        const spawner = new FakeSpawner()
        spawner.next_result = { code: 1, stdout: '', stderr: 'Error: boom' }
        try {
          await client(spawner).launch('nb', {
            'antithesis.integrations.github.token': token
          })
          return false
        } catch (error) {
          return error instanceof ApiError && !error.message.includes(token)
        }
      })
    )
  })
})

describe('SnoutyClient reads', () => {
  it('get_run returns the raw run detail', async () => {
    const spawner = new FakeSpawner()
    spawner.next_result = {
      code: 0,
      stdout:
        '{"run_id":"r","status":"in_progress","sub_status":"Ready","links":{"triage_report":null}}',
      stderr: 'showing run: r\n'
    }
    expect(await client(spawner).get_run('r')).toMatchObject({
      run_id: 'r',
      status: 'in_progress'
    })
    expect(spawner.calls[0].args).toEqual(['--json', 'runs', 'show', 'r'])
  })

  it('list_properties passes the status flag and parses NDJSON with blank lines', async () => {
    const spawner = new FakeSpawner()
    spawner.next_result = {
      code: 0,
      stdout:
        '{"id":"1","name":"a","status":"Failing"}\n\n{"id":"2","name":"b","status":"Failing"}\n',
      stderr: ''
    }
    const props = await client(spawner).list_properties('r', 'Failing')
    expect(props.map(p => p.id)).toEqual(['1', '2'])
    expect(spawner.calls[0].args).toEqual([
      '--json',
      'runs',
      'properties',
      'r',
      '--failing'
    ])
    await client(spawner).list_properties('r')
    expect(spawner.calls[1].args).toEqual(['--json', 'runs', 'properties', 'r'])
  })
})

describe('SnoutyClient.open_stream', () => {
  it('yields open from stderr, one event per stdout line, and ends on exit 0', async () => {
    const spawner = new FakeSpawner()
    spawner.stream_events = [
      { source: 'stderr', line: 'waiting for the run’s stream to open' },
      { source: 'stderr', line: 'the stream of run r is open' },
      {
        source: 'stdout',
        line: '{"event":"property","property_id":"p1","name":"x"}'
      },
      { source: 'stdout', line: 'garbage' },
      { source: 'stdout', line: '{"event":"completed","run_id":"r"}' },
      { source: 'exit', code: 0 }
    ]
    const events = []
    for await (const event of client(spawner).open_stream(
      'r',
      new AbortController().signal
    )) {
      events.push(event)
    }
    expect(events).toEqual([
      { event: 'open' },
      { event: 'property', property_id: 'p1', name: 'x' },
      { event: 'unknown', data: 'garbage' },
      { event: 'completed', run_id: 'r' }
    ])
    expect(spawner.calls[0].args).toEqual(['--json', 'runs', 'stream', 'r'])
  })

  it.each([
    ['Error: the stream ended before the run was final', 'ended_early'],
    ['Error: run r has finished, and has no status stream', 'finished'],
    ['Error: run r has no status stream', 'unsupported'],
    ["error: unrecognized subcommand 'stream'", 'unsupported'],
    ["error: unexpected argument '--undetermined' found", 'unsupported'],
    ['Error: run not found: r', 'not_found'],
    ['Error: API error: 401 Unauthorized', 'unauthorized']
  ])('classifies exit 1 with %j as %s', async (stderr, code) => {
    const spawner = new FakeSpawner()
    spawner.stream_events = [
      { source: 'stderr', line: stderr },
      { source: 'exit', code: 1 }
    ]
    const iterate = async (): Promise<void> => {
      for await (const event of client(spawner).open_stream(
        'r',
        new AbortController().signal
      )) {
        void event
      }
    }
    await expect(iterate()).rejects.toMatchObject({ code })
  })
})

describe('classify_snouty_error', () => {
  it.each([
    ['Error: run not found: x', 'not_found', 404],
    ['Error: API error: 429 Too Many Requests', 'rate_limited', 429],
    ['Error: API error: 403 forbidden', 'unauthorized', 403],
    ['Error: API error: 409 Conflict', 'conflict', 409],
    ['Error: API error: 503 unavailable', 'server', 503],
    [
      'check that credentials have been configured correctly',
      'unauthorized',
      undefined
    ],
    ['something odd', 'other', undefined],
    ['', 'other', undefined]
  ])('maps %j to %s', (stderr, code, status) => {
    const error = classify_snouty_error(stderr, 1)
    expect(error.code).toBe(code)
    expect(error.status).toBe(status)
  })

  it('uses the last Error: line as the message and strips the prefix', () => {
    const error = classify_snouty_error(
      'showing run\nError: first\nnoise\nError: run not found: x\n',
      1
    )
    expect(error.message).toBe('run not found: x')
  })

  it('names the exit code when stderr is empty', () => {
    expect(classify_snouty_error('', 137).message).toBe(
      'snouty exited with code 137'
    )
  })
})

describe('parse_stream_line', () => {
  it('wraps anything without an event key as unknown', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const line = JSON.stringify(value)
        const parsed = parse_stream_line(line)
        const has_event =
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          typeof (value as { event?: unknown }).event === 'string'
        return has_event
          ? parsed.event !== 'unknown'
          : parsed.event === 'unknown'
      })
    )
  })
})
