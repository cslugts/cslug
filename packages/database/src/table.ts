import type { AnyColumn, Column, Generated, Hidden } from './columns'
import { decrypt } from './encryption'
import { IDENT, quote, type SqlIdentifier } from './sql'

export type Columns = Record<string, AnyColumn>

type ValueOf<C> = C extends Column<infer T, infer N, boolean> ? (N extends true ? T | null : T) : never
type Flatten<T> = { [K in keyof T]: T[K] } & {}
type OptionalKeys<C extends Columns> = {
  [K in keyof C]: C[K] extends Column<unknown, boolean, true> ? K : never
}[keyof C]

type HiddenKeys<C extends Columns> = { [K in keyof C]: C[K] extends Hidden ? K : never }[keyof C]
type GeneratedKeys<C extends Columns> = { [K in keyof C]: C[K] extends Generated ? K : never }[keyof C]
type Writable<C extends Columns> = Exclude<keyof C, GeneratedKeys<C>>

/** What a SELECT returns: every column but the hidden ones, nullable ones as `T | null`. */
export type Row<T extends Table> = Flatten<{
  [K in Exclude<keyof T['columns'], HiddenKeys<T['columns']>>]: ValueOf<T['columns'][K]>
}>

/** What an INSERT needs: NOT NULL columns without a default are required; the rest optional; generated ones absent. */
export type NewRow<T extends Table> = Flatten<
  {
    [K in Exclude<Writable<T['columns']>, OptionalKeys<T['columns']>>]: ValueOf<T['columns'][K]>
  } & {
    [K in Extract<Writable<T['columns']>, OptionalKeys<T['columns']>>]?: ValueOf<T['columns'][K]>
  }
>

/** `fooBar` → `foo_bar` */
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** A column reference that renders as `"table"."column"` in the sql tag. */
export type ColumnRef = SqlIdentifier & { readonly name: string; readonly key: string; readonly table: string }

/**
 * An index: its columns, and for other access methods than btree `using` (`gin`, `gist`, `brin`, `hash`) and an
 * operator class per column (`gin_trgm_ops`; null for the default).
 */
export type IndexDef = { columns: string[]; unique: boolean; name: string; using?: string; ops?: (string | null)[] }

type IndexBuilder<C extends Columns> = {
  index(...keys: (keyof C & string)[]): IndexDef
  unique(...keys: (keyof C & string)[]): IndexDef
  /** `t.using('gin', 'search')`, `t.using('gin', ['title', 'gin_trgm_ops'])`: `<table>_<columns>_<method>_idx`. */
  using(method: string, ...keys: ((keyof C & string) | [keyof C & string, string])[]): IndexDef
}

/** A typed table: columns, keys and indexes; `table()` creates one. */
export class Table<C extends Columns = Columns> implements SqlIdentifier {
  readonly [IDENT]: string
  /** Column references for the sql tag: `${bookings.c.startDate}` → `"bookings"."start_date"`. */
  readonly c: { readonly [K in keyof C]: ColumnRef }
  /** `${bookings.star}` → `"bookings".*` */
  readonly star: SqlIdentifier
  /** TS key → SQL column name. */
  readonly sqlNames: ReadonlyMap<string, string>
  readonly indexes: IndexDef[]
  readonly primaryKey: string
  /** What a SELECT lists: `"t".*`, or the visible columns when some are hidden. */
  readonly selection: SqlIdentifier
  /** Generated columns: TS key → their SQL expression. */
  readonly generatedSql: ReadonlyMap<string, string>

  constructor(
    readonly name: string,
    readonly columns: C,
    options: { indexes?: (t: IndexBuilder<C>) => IndexDef[] } = {},
  ) {
    this[IDENT] = quote(name)
    const names = new Map<string, string>()
    const refs: Record<string, ColumnRef> = {}
    for (const key of Object.keys(columns)) {
      const column = snake(key)
      names.set(key, column)
      refs[key] = { [IDENT]: `${quote(name)}.${quote(column)}`, name: column, key, table: name }
    }
    this.sqlNames = names
    this.c = refs as Table<C>['c']
    this.star = { [IDENT]: `${quote(name)}.*` }
    const hidden = Object.entries(columns).filter(([, c]) => c.def.hidden)
    this.selection = hidden.length
      ? {
          [IDENT]: Object.keys(columns)
            .filter((k) => !columns[k]?.def.hidden)
            .map((k) => refs[k]?.[IDENT])
            .join(', '),
        }
      : this.star
    const generated = new Map<string, string>()
    for (const [key, column] of Object.entries(columns))
      if (column.def.generated)
        generated.set(
          key,
          column.def.generated((k) => {
            if (!(k in columns)) throw new Error(`${name}.${key}: generatedAs() refers to an unknown column "${k}"`)
            return quote(snake(k))
          }),
        )
    this.generatedSql = generated
    this.primaryKey = Object.entries(columns).find(([, c]) => c.def.primary)?.[0] ?? 'id'
    const builder: IndexBuilder<C> = {
      index: (...keys) => ({
        columns: keys.map(snake),
        unique: false,
        name: `${name}_${keys.map(snake).join('_')}_idx`,
      }),
      unique: (...keys) => ({
        columns: keys.map(snake),
        unique: true,
        name: `${name}_${keys.map(snake).join('_')}_key`,
      }),
      using: (method, ...keys) => {
        const cols = keys.map((k) => snake(Array.isArray(k) ? k[0] : k))
        const ops = keys.map((k) => (Array.isArray(k) ? k[1] : null))
        return {
          columns: cols,
          unique: false,
          name: `${name}_${cols.join('_')}_${method}_idx`,
          using: method,
          ...(ops.some(Boolean) ? { ops } : {}),
        }
      },
    }
    this.indexes = options.indexes?.(builder) ?? []
  }

  /** True when the table has `deletedAt` (soft deletes). */
  get softDeletes(): boolean {
    return 'deletedAt' in this.columns
  }

  /** A database row (snake_case, driver types) → the app row (camelCase, cslug types); `extras` are copied as is. */
  fromDb(raw: Record<string, unknown>, extras: readonly string[] = []): Row<this> {
    const out: Record<string, unknown> = {}
    for (const name of extras) out[name] = raw[name]
    for (const [key, column] of Object.entries(this.columns)) {
      const name = this.sqlNames.get(key) as string
      if (!(name in raw) || column.def.hidden) continue
      const value = raw[name]
      out[key] =
        column.def.encrypted && typeof value === 'string' ? decrypt(value) : convertFromDb(value, column.def.kind)
    }
    return out as Row<this>
  }

  /** App values (camelCase) → `[sqlName, value]` pairs, for known, writable (not generated) columns only. */
  toDb(values: Record<string, unknown>): [string, unknown, AnyColumn][] {
    const out: [string, unknown, AnyColumn][] = []
    for (const [key, value] of Object.entries(values)) {
      const column = this.columns[key]
      if (!column || value === undefined || column.def.generated) continue
      out.push([this.sqlNames.get(key) as string, value, column])
    }
    return out
  }
}

function convertFromDb(value: unknown, kind: string): unknown {
  if (value === null || value === undefined) return null
  switch (kind) {
    case 'date':
      return value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
    case 'bigint':
      return typeof value === 'bigint' ? value : BigInt(value as string)
    case 'integer':
      return typeof value === 'number' ? value : Number(value)
    case 'numeric':
      return String(value)
    case 'char':
      return String(value).trimEnd()
    default:
      return value
  }
}

/** Define a table: `export const bookings = table('bookings', { id: id(), … })`. */
export function table<C extends Columns>(
  name: string,
  columns: C,
  options: { indexes?: (t: IndexBuilder<C>) => IndexDef[] } = {},
): Table<C> {
  return new Table(name, columns, options)
}
