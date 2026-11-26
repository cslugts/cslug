import type { AnyColumn } from './columns'
import { encrypt } from './encryption'
import { sql } from './sql'

/** A value as written to the database: jsonb columns are bound as JSON. */
export function writeValue(value: unknown, column: AnyColumn): unknown {
  if (value === null || value === undefined) return null
  if (column.def.encrypted) return encrypt(String(value))
  return column.def.kind === 'jsonb' ? sql.json(value) : value
}
