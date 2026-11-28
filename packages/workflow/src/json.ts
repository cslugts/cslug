/** What a value becomes once stored as JSON: bigint and Date as strings, functions and undefined dropped. */
export type Json<T> = T extends bigint | Date
  ? string
  : T extends (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T

/** A JSON-safe copy (bigint → string); undefined → null. */
export function toJson<T>(value: T): Json<T> {
  if (value === undefined) return null as Json<T>
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Json<T>
}

/** An error as JSON: name, message and code. */
export function errorJson(error: unknown): { name: string; message: string; code?: string } {
  const e = error instanceof Error ? error : new Error(String(error))
  const code = (e as { code?: unknown }).code
  return { name: e.name, message: e.message, ...(typeof code === 'string' ? { code } : {}) }
}
