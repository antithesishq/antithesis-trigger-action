import * as core from '@actions/core'

export function getinput_or_undefined(input_name: string): string | undefined {
  const input_val = core.getInput(input_name)
  return input_val === '' ? undefined : input_val
}

export function shallow_prune_undefined_values<O extends object>(
  obj: O
): Partial<O> {
  const keys = Object.keys(obj) as Array<keyof O>
  const keys_with_defined_value = keys.filter(k => obj[k] !== undefined)
  return Object.fromEntries(
    keys_with_defined_value.map(k => [k, obj[k]])
  ) as Partial<O>
}

function parse_parts(
  line: string
): { name: string; value: string } | undefined {
  const trimmed = line?.trim()
  if (!trimmed) return undefined

  const parts = trimmed.split('=')

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

/**
 * Parse a duration input into milliseconds. A bare number is seconds; otherwise
 * any combination of `<n>h`, `<n>m`, `<n>s` in that order (`5h50m`, `90s`).
 */
export function parse_duration(value: string): number {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000

  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(trimmed)
  if (trimmed === '' || match === null) {
    throw new Error(
      `Invalid duration "${value}": use seconds, or a combination of h/m/s such as 30s, 5m, 2h, 5h50m`
    )
  }
  const [, hours, minutes, seconds] = match
  const total_seconds =
    Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  return total_seconds * 1000
}

/** Resolve after `ms`, or at once when `signal` aborts. Never rejects. */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return
  await new Promise<void>(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
