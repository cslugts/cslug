/**
 * The `sql` tag: SQL text with bound parameters. Interpolated values always become `$n` parameters; tables and
 * columns become quoted identifiers; nested fragments are inlined. There is no API that takes a SQL string, so
 * user input cannot be concatenated into a query.
 */
export const IDENT: unique symbol = Symbol('cslug.sql.identifier')

/** Something that renders as SQL text (a table, a column reference, an identifier). */
export interface SqlIdentifier {
  readonly [IDENT]: string
}

export const isIdentifier = (v: unknown): v is SqlIdentifier => typeof v === 'object' && v !== null && IDENT in v

/** Quote an identifier: `booking"s` → `"booking""s"`. */
export const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`

/** A piece of SQL with its parameters. `T` is the row type when the fragment is a whole query. */
export class SqlFragment<T = Record<string, unknown>> {
  declare readonly _row: T
  constructor(
    readonly parts: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  /** Compile to text with `$1…$n` and the parameter list. */
  compile(offset = 0): { text: string; params: unknown[] } {
    const params: unknown[] = []
    let text = ''
    const walk = (fragment: SqlFragment<unknown>) => {
      fragment.parts.forEach((part, i) => {
        text += part
        if (i >= fragment.values.length) return
        const value = fragment.values[i]
        if (value instanceof SqlFragment) walk(value)
        else if (isIdentifier(value)) text += value[IDENT]
        else if (value instanceof Raw) text += value.text
        else if (value instanceof JsonParam) {
          params.push(value.json)
          text += `($${offset + params.length}::text)::jsonb`
        } else {
          params.push(value === undefined ? null : value)
          text += `$${offset + params.length}`
        }
      })
    }
    walk(this as SqlFragment<unknown>)
    return { text, params }
  }

  toString(): string {
    return this.compile().text
  }
}

/** Trusted SQL text, inserted as is. Only for constants written in code (lint-flagged). */
export class Raw {
  constructor(readonly text: string) {}
}

/** A JSON value bound as a jsonb parameter (Bun.sql would double-encode a string, and mangle arrays). */
export class JsonParam {
  readonly json: string
  constructor(value: unknown) {
    this.json = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  }
}

type SqlTag = {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment<T>
  /** Join fragments or values with a separator fragment: `sql.join(ids, sql\`, \`)`. */
  join(items: readonly unknown[], separator?: SqlFragment<unknown>): SqlFragment<unknown>
  /** Trusted SQL text (constants only). */
  raw(text: string): Raw
  /** A quoted identifier from a name, e.g. a schema. */
  ident(...names: string[]): SqlIdentifier
  /** A JSON value for a jsonb column or parameter. */
  json(value: unknown): JsonParam
  /** Empty fragment. */
  empty: SqlFragment<unknown>
}

/** Tagged template: values become bound parameters, `SqlIdentifier`s and fragments are inlined. */
export const sql: SqlTag = Object.assign(
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) =>
    new SqlFragment<T>([...strings], values),
  {
    join(
      items: readonly unknown[],
      separator: SqlFragment<unknown> = new SqlFragment([', '], []),
    ): SqlFragment<unknown> {
      if (!items.length) return new SqlFragment([''], [])
      const parts: string[] = ['']
      const values: unknown[] = []
      items.forEach((item, i) => {
        if (i > 0) {
          values.push(separator)
          parts.push('')
        }
        values.push(item)
        parts.push('')
      })
      return new SqlFragment(parts, values)
    },
    raw: (text: string) => new Raw(text),
    ident: (...names: string[]): SqlIdentifier => ({ [IDENT]: names.map(quote).join('.') }),
    json: (value: unknown) => new JsonParam(value),
    empty: new SqlFragment<unknown>([''], []),
  },
)
