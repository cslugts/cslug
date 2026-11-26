/** What JSON delivers to an island: `bigint` → string, `Date` → ISO string, recursively. */
export type Serialized<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends { toJSON(): infer J }
      ? J
      : T extends (infer U)[]
        ? Serialized<U>[]
        : T extends object
          ? { [K in keyof T]: Serialized<T[K]> }
          : T

/**
 * Convert a value to exactly what an island receives (and type it so): `<TodoItem :todo="serialize(todo)" hydrate />`.
 * With `check`, functions, class instances (other than Date and values with `toJSON`), and cycles are reported.
 */
export function serialize<T>(value: T, check?: (problem: string) => void): Serialized<T> {
  if (check) inspect(value, '', new Set(), check)
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? 'null',
  ) as Serialized<T>
}

function inspect(value: unknown, path: string, seen: Set<unknown>, report: (problem: string) => void): void {
  if (typeof value === 'function') {
    report(`${path || 'value'} is a function (dropped)`)
    return
  }
  if (
    !value ||
    typeof value !== 'object' ||
    value instanceof Date ||
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  )
    return
  if (seen.has(value)) {
    report(`${path || 'value'} is circular`)
    return
  }
  seen.add(value)
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    report(
      `${path || 'value'} is a ${proto?.constructor?.name ?? 'class'} instance (only its fields reach the browser)`,
    )
  }
  for (const [k, v] of Object.entries(value)) inspect(v, path ? `${path}.${k}` : k, seen, report)
  seen.delete(value)
}
