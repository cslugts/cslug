import {
  ArraySchema,
  BooleanSchema,
  DefaultSchema,
  NullableSchema,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  type Schema,
} from '@cslug/validation'

/** Form keys with brackets → nested objects: `budget[amount]=1` → `{ budget: { amount: '1' } }`; `tags[]=a`. */
export function nestKeys(entries: Iterable<[string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    const path = key.replace(/\]/g, '').split('[')
    let node: Record<string, unknown> = out
    path.forEach((part, i) => {
      const last = i === path.length - 1
      const nextIsArray = path[i + 1] === ''
      if (part === '') return
      if (last || (i === path.length - 2 && nextIsArray)) {
        if (nextIsArray) {
          const list = Array.isArray(node[part]) ? (node[part] as unknown[]) : []
          list.push(value)
          node[part] = list
        } else if (part in node && !Array.isArray(node[part]) && typeof node[part] !== 'object') {
          node[part] = [node[part], value] // a repeated key becomes a list
        } else node[part] = value
        return
      }
      node[part] ??= {}
      node = node[part] as Record<string, unknown>
    })
  }
  return out
}

const unwrap = (s: Schema): Schema => {
  let current: Schema = s
  for (;;) {
    if (current instanceof OptionalSchema || current instanceof NullableSchema || current instanceof DefaultSchema)
      current = current.inner as Schema
    else return current
  }
}

/**
 * Strings from query strings and HTML forms → what the schema expects: numbers, booleans (checkboxes), single
 * values → arrays, and empty strings → undefined for optional fields (an empty input means "not given").
 */
export function coerceForm(schema: Schema, value: unknown): unknown {
  const target = unwrap(schema)
  const optional = target !== schema
  if (value === '' && optional) return undefined
  if (target instanceof ObjectSchema && value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const [k, s] of Object.entries(target.shape as Record<string, Schema>)) out[k] = coerceForm(s, out[k])
    return out
  }
  if (target instanceof ArraySchema) {
    if (value === undefined || value === '') return optional ? undefined : []
    return (Array.isArray(value) ? value : [value]).map((v) => coerceForm(target.element as Schema, v))
  }
  if (typeof value !== 'string') return value
  if (target instanceof NumberSchema && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  if (target instanceof BooleanSchema) {
    if (['1', 'on', 'true', 'yes'].includes(value.toLowerCase())) return true
    if (['0', 'off', 'false', 'no'].includes(value.toLowerCase())) return false
  }
  return value
}
