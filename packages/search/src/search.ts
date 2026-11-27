import type { Query, Row, Table } from '@cslug/database'
import { type SqlFragment, sql } from '@cslug/database'
import { type SearchConfig, searchColumnOf } from './searchable'

export type SearchOptions<K extends string> = {
  /** The `searchable()` column, when the table has several. */
  column?: string
  /**
   * Search in one language only: a value of the language column (`fr`) or a configuration of the column (`french`).
   * Default: every language of the column at once.
   */
  language?: string
  /**
   * Columns to return with the matching words in `<mark>…</mark>`, as `highlight.<column>`. The text is HTML-escaped
   * first, so the result is safe to render as HTML. `words` per fragment (30), `fragments` (2; 0 for the whole text).
   */
  highlight?: K[] | { columns: K[]; words?: number; fragments?: number }
  /**
   * Columns matched by word similarity too (pg_trgm), so `isallo` finds `Isalo`. Each needs a trigram index:
   * `t.using('gin', ['title', 'gin_trgm_ops'])`.
   */
  typos?: K[]
}

type Source<T extends Table, R> = Query<T, R> | { query(): Query<T, R> }
type Highlighted<K extends string> = [K] extends [never] ? unknown : { highlight: Record<K, string> }

const quoted = (s: string) => sql.raw(`'${s.replace(/'/g, "''")}'`)
const escapeHtml = (text: unknown) =>
  sql`replace(replace(replace(replace(coalesce(${text}, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')`

function languages(config: SearchConfig, language: string | undefined): string[] {
  if (language === undefined) return config.configs
  const byValue = config.byColumn?.configs[language]
  if (byValue) return [byValue]
  const named = config.configs.find((c) => c === language || c === `cslug_${language}`)
  if (named) return [named]
  throw new Error(`search(): "${language}" is not a language of this search column (${config.configs.join(', ')})`)
}

/**
 * A full-text search on a repository or a query, ranked: the rows that match `term` (web-search syntax: `"exact
 * phrase"`, `-without`, `or`), best first, each with its `rank` (and `highlight` when asked). The result is a query:
 * keep chaining `where`, `orderBy` (after the rank), `paginate`.
 *
 * ```ts
 * const page = await search(this.circuits, 'isalo 4x4', { highlight: ['summary'] }).where({ published: true }).paginate()
 * ```
 */
export function search<T extends Table, R, K extends keyof Row<T> & string = never>(
  source: Source<T, R>,
  term: string,
  options: SearchOptions<K> = {},
): Query<T, R & { rank: number } & Highlighted<K>> {
  const query = 'query' in source && typeof source.query === 'function' ? source.query() : (source as Query<T, R>)
  const table = query.table
  const { key, config } = searchColumnOf(table, options.column)
  const col = (k: string): unknown => (table.c as Record<string, unknown>)[k]
  const vector = col(key)
  const used = languages(config, options.language)
  const tsquery = sql`(${sql.join(
    used.map((cfg) => sql`websearch_to_tsquery(${quoted(cfg)}::regconfig, ${term})`),
    sql` || `,
  )})`
  const typos = options.typos ?? []
  const similar = typos.map((f) => sql`word_similarity(${term}, ${col(f)})`)
  const rank = similar.length
    ? sql<number>`(ts_rank_cd(${vector}, ${tsquery}, 32) + 0.3 * greatest(${sql.join(similar)}))::float8`
    : sql<number>`ts_rank_cd(${vector}, ${tsquery}, 32)::float8`

  let q = query.selectSql('rank', rank) as Query<T, R & { rank: number }>
  if (/\w/.test(term)) {
    const match = sql`${vector} @@ ${tsquery}`
    const condition = typos.length
      ? sql`(${match} or ${sql.join(
          typos.map((f) => sql`${term} <% ${col(f)}`),
          sql` or `,
        )})`
      : match
    q = q.whereSql(condition).orderBySql(sql`${sql.ident('rank')} desc`)
  }

  const highlight = options.highlight
  if (!highlight) return q as Query<T, R & { rank: number } & Highlighted<K>>
  const { columns, words = 30, fragments = 2 } = Array.isArray(highlight) ? { columns: highlight } : highlight
  const settings = quoted(
    `StartSel=<mark>, StopSel=</mark>, MaxWords=${words}, MinWords=${Math.max(1, Math.min(10, words - 1))}, ` +
      `MaxFragments=${fragments}, FragmentDelimiter=" … "`,
  )
  const headline = (column: K, cfg: string) =>
    sql`ts_headline(${quoted(cfg)}::regconfig, ${escapeHtml(col(column))}, ${tsquery}, ${settings})`
  const perRow = (column: K) => {
    const b = config.byColumn
    if (!b || used.length === 1) return headline(column, used[0] as string)
    const cases = Object.entries(b.configs).map(
      ([value, cfg]) => sql`when ${quoted(value)} then ${headline(column, cfg)}`,
    )
    return sql`case ${col(b.column)} ${sql.join(cases, sql` `)} else ${headline(column, b.fallback)} end`
  }
  return q.selectSql(
    'highlight',
    sql<Record<K, string>>`json_build_object(${sql.join(columns.flatMap((c) => [quoted(c), perRow(c)]))})`,
  ) as Query<T, R & { rank: number } & Highlighted<K>>
}
