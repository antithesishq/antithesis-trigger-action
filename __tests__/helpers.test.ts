import * as core from '@actions/core'
import * as fc from 'fast-check'
import * as helpers from '../src/helpers'

describe('successful_params_parsing', () => {
  it('empty params', async () => {
    const params = helpers.parse_additional_parameters(``)

    expect(params).toEqual({})
  })

  it('one line params', async () => {
    const params = helpers.parse_additional_parameters(`p=v`)

    expect(params).toEqual({ p: 'v' })
  })

  it('two line params', async () => {
    const params = helpers.parse_additional_parameters(`

    p1=v1


    p2=v2

    `)

    expect(params).toEqual({ p1: 'v1', p2: 'v2' })
  })

  it('five line params', async () => {
    const params = helpers.parse_additional_parameters(`p=v
    p1 =    v1
    p2 = v2
    p3 = v3
    p4 = v4
    `)

    expect(params).toEqual({ p: 'v', p1: 'v1', p2: 'v2', p3: 'v3', p4: 'v4' })
  })

  it('leading empty space in params', async () => {
    const params = helpers.parse_additional_parameters(`


    p   =   v`)

    expect(params).toEqual({ p: 'v' })
  })

  it('trailing empty space in params', async () => {
    const params = helpers.parse_additional_parameters(`p=v



    `)

    expect(params).toEqual({ p: 'v' })
  })

  it('two line params with equal', async () => {
    const params = helpers.parse_additional_parameters(`
    p1='inner_value_1=1'
    p2='v2'`)

    expect(params).toEqual({ p1: "'inner_value_1=1'", p2: "'v2'" })
  })

  it('warns and skips lines without an = sign', async () => {
    const warningMock = jest.spyOn(core, 'warning').mockImplementation()

    const params = helpers.parse_additional_parameters(`p1=v1
no_equals_here
p2=v2`)

    expect(params).toEqual({ p1: 'v1', p2: 'v2' })
    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('no_equals_here')
    )
  })
})

describe('parse_duration', () => {
  it.each([
    ['30', 30_000],
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['5h50m', 21_000_000],
    ['1h2m3s', 3_723_000],
    [' 90s ', 90_000],
    ['0', 0]
  ])('parses %s', (input, expected) => {
    expect(helpers.parse_duration(input)).toBe(expected)
  })

  it.each(['', 'abc', '5x', '1m5h', '-3s', '1.5h'])('rejects %j', input => {
    expect(() => helpers.parse_duration(input)).toThrow(/Invalid duration/)
  })

  it('round-trips any h/m/s combination', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 48 }),
        fc.nat({ max: 59 }),
        fc.nat({ max: 59 }),
        (h, m, s) => {
          const text = `${h}h${m}m${s}s`
          expect(helpers.parse_duration(text)).toBe(
            ((h * 60 + m) * 60 + s) * 1000
          )
        }
      )
    )
  })
})

describe('sleep', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('resolves after the delay', async () => {
    let done = false
    const pending = (async (): Promise<void> => {
      await helpers.sleep(1000)
      done = true
    })()
    await jest.advanceTimersByTimeAsync(999)
    expect(done).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toBe(true)
  })

  it('resolves at once when aborted', async () => {
    const controller = new AbortController()
    const pending = helpers.sleep(60_000, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves at once for an already aborted signal or a zero delay', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      helpers.sleep(60_000, controller.signal)
    ).resolves.toBeUndefined()
    await expect(helpers.sleep(0)).resolves.toBeUndefined()
  })
})
