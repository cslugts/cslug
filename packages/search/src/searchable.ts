import { join } from 'node:path'
import { type Column, custom, type Generated, type Hidden, type Table } from '@cslug/database'

/** The `cslug_search` migration: unaccent, pg_trgm, and the accent-insensitive `cslug_<config>` configurations. */
export const SEARCH_MIGRATIONS = join(import.meta.dir, '../migrations')
/** The embeddings migration (pgvector), registered with `search.vectors: true`. */
export const VECTOR_MIGRATIONS = join(import.meta.dir, '../migrations-vectors')

/** A weight per searchable column: `A` counts most, then `B`, `C`, `D`. */
export type Weights = Record<string, 'A' | 'B' | 'C' | 'D'>

/**
 * The language of the text: a PostgreSQL text search configuration (`english`, `french`, `italian`, `simple`…), or a
 * column naming each row's language with the configuration for each value.
 */
export type Language = string | { column: string; configs: Record<string, string>; fallback?: string }

export type SearchableOptions = {
  /** Default `simple` (no stemming). */
  language?: Language
  /** Ignore accents (`éléphant` = `elephant`), through the `cslug_<config>` copies; default true. */
  unaccent?: boolean
}

/** What `search()` needs to know about a search column. */
export type SearchConfig = {
  weights: Weights
  /** The configurations in use (fixed: one; per row: each value's, then the fallback). */
  configs: string[]
  /** Per-row language: the column (TS key) and value → configuration. */
  byColumn?: { column: string; configs: Record<string, string>; fallback: string }
}

const configs = new WeakMap<object, SearchConfig>()

const LANGUAGE = /^[a-z_]+$/
const config = (name: string, unaccent: boolean) => {
  if (!LANGUAGE.test(name)) throw new Error(`Not a text search configuration name: "${name}"`)
  return unaccent ? `cslug_${name}` : name
}
const literal = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * A search column: a hidden `tsvector` PostgreSQL computes from weighted columns, kept up to date on every write.
 * Index it with `t.using('gin', 'search')`.
 *
 * ```ts
 * search: searchable({ title: 'A', summary: 'B', body: 'C' }, { language: 'french' })
 * search: searchable({ title: 'A', body: 'B' }, { language: { column: 'locale', configs: { fr: 'french', en: 'english' } } })
 * ```
 */
export function searchable(
  weights: Weights,
  options: SearchableOptions = {},
): Column<string, false, true> & Generated & Hidden {
  const unaccent = options.unaccent !== false
  const language = options.language ?? 'simple'
  const byColumn =
    typeof language === 'string'
      ? undefined
      : {
          column: language.column,
          configs: Object.fromEntries(Object.entries(language.configs).map(([v, c]) => [v, config(c, unaccent)])),
          fallback: config(language.fallback ?? 'simple', unaccent),
        }
  const fixed = typeof language === 'string' ? config(language, unaccent) : undefined
  for (const w of Object.values(weights))
    if (!['A', 'B', 'C', 'D'].includes(w)) throw new Error(`Search weights are A, B, C or D (got "${w}")`)

  const column = custom('tsvector')
    .generatedAs((c) => {
      const vector = (cfg: string) =>
        Object.entries(weights)
          .map(([key, w]) => `setweight(to_tsvector(${literal(cfg)}, coalesce(${c(key)}, '')), '${w}')`)
          .join(' || ')
      if (fixed) return vector(fixed)
      const b = byColumn as NonNullable<typeof byColumn>
      const cases = Object.entries(b.configs).map(([value, cfg]) => `when ${literal(value)} then ${vector(cfg)}`)
      return `case ${c(b.column)} ${cases.join(' ')} else ${vector(b.fallback)} end`
    })
    .hidden()
  configs.set(column.def, {
    weights,
    configs: fixed ? [fixed] : [...new Set([...Object.values(byColumn?.configs ?? {}), byColumn?.fallback as string])],
    ...(byColumn ? { byColumn } : {}),
  })
  return column
}

/** The search column of a table (the one named `key`, or the only `searchable()` one) and its configuration. */
export function searchColumnOf(table: Table, key?: string): { key: string; config: SearchConfig } {
  const found = Object.entries(table.columns).filter(([k, c]) => configs.has(c.def) && (key === undefined || k === key))
  if (found.length === 1) {
    const [k, c] = found[0] as [string, { def: object }]
    return { key: k, config: configs.get(c.def) as SearchConfig }
  }
  throw new Error(
    found.length
      ? `${table.name} has several searchable() columns (${found.map(([k]) => k).join(', ')}): pass { column }`
      : `${table.name} has no searchable() column${key ? ` named "${key}"` : ''}`,
  )
}
