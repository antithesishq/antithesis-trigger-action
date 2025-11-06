import * as core from '@actions/core'

export function getinput_or_undefined(input_name: string): string | undefined {
  const input_val = core.getInput(input_name)
  return input_val === '' ? undefined : input_val
}

export function shallow_prune_undefined_values<O extends object>(
  obj: O
): Partial<O> {
  const keys = Object.keys(obj) as (keyof O)[]
  const keys_with_defined_value = keys.filter(k => obj[k] !== undefined)
  return Object.fromEntries(
    keys_with_defined_value.map(k => [k, obj[k]])
  ) as Partial<O>
}

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
