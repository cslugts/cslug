import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Application, Clock, CslugError, resolve } from '@cslug/core'
import { Database, type Page, sql } from '@cslug/database'

/** A document of an index: its `key` is unique in the index. */
export type SearchDocument<M extends Record<string, unknown> = Record<string, unknown>> = {
  key: string
  title?: string
  body?: string
  metadata?: M
  /** One of the index's languages (default: its first). */
  language?: string
}

/** A search result: the document without its body, its rank and, when asked, highlights. */
export type SearchHit<M extends Record<string, unknown> = Record<string, unknown>> = {
  key: string
  title: string
  metadata: M
  rank: number
  highlight?: { title: string; body: string }
}

export type SearchIndexOptions<M extends Record<string, unknown>> = {
  /** Text search configurations documents may use (`french`, `english`…); the first is the default. Default `simple`. */
  languages?: string[]
  /** Ignore accents (`cslug_<config>`), default true. */
  unaccent?: boolean
  /** Every document of the index, for `cslug search:reindex`: the index then holds exactly these. */
  documents?: () => AsyncIterable<SearchDocument<M>> | Iterable<SearchDocument<M>>
}

export type IndexSearchOptions<M extends Record<string, unknown>> = {
  page?: number
  perPage?: number
  /** Only documents whose metadata contains these values (`metadata @> filter`). */
  filter?: Partial<M>
  /** One language of the index instead of all of them. */
  language?: string
  /** `<mark>` highlights of the title and body (HTML-escaped first). */
  highlight?: boolean | { words?: number; fragments?: number }
  /** Also match titles similar to the term (pg_trgm), ranked lower. */
  typos?: boolean
}

const TABLE = sql`cslug_search_documents`
const NAME = /^[a-z_]+$/
const quoted = (s: string) => sql.raw(`'${s.replace(/'/g, "''")}'`)
const escapeHtml = (text: unknown) =>
  sql`replace(replace(replace(replace(${text}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')`

const registry = new Map<string, SearchIndex<Record<string, unknown>>>()

/**
 * Documents that are not table rows (help pages, files, transcripts), searched like `search()` searches tables. Rows
 * live in `cslug_search_documents`; the vector is generated from the title (weight A) and the body (B) in the
 * document's language.
 */
export class SearchIndex<M extends Record<string, unknown> = Record<string, unknown>> {
  readonly configs: string[]

  constructor(
    readonly name: string,
    readonly options: SearchIndexOptions<M> = {},
  ) {
    const languages = options.languages ?? ['simple']
    if (!languages.length) throw new Error(`searchIndex('${name}'): languages is empty`)
    this.configs = languages.map((l) => {
      if (!NAME.test(l)) throw new Error(`Not a text search configuration name: "${l}"`)
      return options.unaccent === false ? l : `cslug_${l}`
    })
  }

  private get db(): Database {
    return resolve(Database)
  }

  private config(language: string | undefined): string {
    if (language === undefined) return this.configs[0] as string
    const found = this.configs.find((c) => c === language || c === `cslug_${language}`)
    if (!found)
      throw new CslugError(
        'search.unknown_language',
        `"${language}" is not a language of index ${this.name} (${(this.options.languages ?? ['simple']).join(', ')})`,
      )
    return found
  }

  /** Add or replace documents (by key), in one statement. */
  async upsertMany(documents: SearchDocument<M>[]): Promise<void> {
    if (!documents.length) return
    const now = resolve(Clock).now()
    const rows = documents.map(
      (d) =>
        sql`(${this.name}, ${d.key}, ${d.title ?? ''}, ${d.body ?? ''}, ${quoted(this.config(d.language))}::regconfig,
          ${sql.json(d.metadata ?? {})}, ${now})`,
    )
    await this.db.exec(sql`insert into ${TABLE} (index, key, title, body, config, metadata, updated_at)
      values ${sql.join(rows)}
      on conflict (index, key) do update set title = excluded.title, body = excluded.body, config = excluded.config,
        metadata = excluded.metadata, updated_at = excluded.updated_at`)
  }

  upsert(document: SearchDocument<M>): Promise<void> {
    return this.upsertMany([document])
  }

  /** Remove documents by key; returns how many were there. */
  remove(...keys: string[]): Promise<number> {
    if (!keys.length) return Promise.resolve(0)
    return this.db.exec(sql`delete from ${TABLE} where index = ${this.name} and key in (${sql.join(keys)})`)
  }

  /** Remove every document of the index. */
  clear(): Promise<number> {
    return this.db.exec(sql`delete from ${TABLE} where index = ${this.name}`)
  }

  async count(): Promise<number> {
    return Number(await this.db.value(sql`select count(*)::int from ${TABLE} where index = ${this.name}`))
  }

  /** The best matches for `term` (web-search syntax), as a page. */
  async search(term: string, options: IndexSearchOptions<M> = {}): Promise<Page<SearchHit<M>>> {
    const { page = 1, perPage = 20 } = options
    const configs = options.language === undefined ? this.configs : [this.config(options.language)]
    const tsquery = sql`(${sql.join(
      configs.map((c) => sql`websearch_to_tsquery(${quoted(c)}::regconfig, ${term})`),
      sql` || `,
    )})`
    const blank = !/\w/.test(term)
    const match = blank
      ? sql`true`
      : options.typos
        ? sql`(vector @@ ${tsquery} or ${term} <% title)`
        : sql`vector @@ ${tsquery}`
    const rank = options.typos
      ? sql`(ts_rank_cd(vector, ${tsquery}, 32) + 0.3 * word_similarity(${term}, title))::float8`
      : sql`ts_rank_cd(vector, ${tsquery}, 32)::float8`
    const filter = options.filter ? sql` and metadata @> ${sql.json(options.filter)}` : sql.empty
    const where = sql`where index = ${this.name} and ${match}${filter}`
    const h = options.highlight
    const { words = 30, fragments = 2 } = typeof h === 'object' ? h : {}
    const settings = quoted(
      `StartSel=<mark>, StopSel=</mark>, MaxWords=${words}, MinWords=${Math.max(1, Math.min(10, words - 1))}, ` +
        `MaxFragments=${fragments}, FragmentDelimiter=" … "`,
    )
    const highlight = h
      ? sql`, json_build_object('title', ts_headline(config, ${escapeHtml(sql`title`)}, ${tsquery}, ${settings}),
          'body', ts_headline(config, ${escapeHtml(sql`body`)}, ${tsquery}, ${settings})) as highlight`
      : sql.empty
    const p = Math.max(1, Math.floor(page))
    const total = Number(await this.db.value(sql`select count(*)::int from ${TABLE} ${where}`))
    const data = await this.db.many<SearchHit<M>>(
      sql`select key, title, metadata, ${rank} as rank${highlight} from ${TABLE} ${where}
        order by rank desc, key limit ${perPage} offset ${(p - 1) * perPage}`,
    )
    return { data, meta: { page: p, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)) } }
  }

  /**
   * Replace the index's content with what `documents()` yields (in batches): documents it no longer yields are
   * removed. Returns the counts.
   */
  async reindex(batch = 500): Promise<{ indexed: number; removed: number }> {
    const source = this.options.documents
    if (!source)
      throw new CslugError('search.no_source', `Index ${this.name} has no documents() source to reindex from`)
    const started = resolve(Clock).now()
    let indexed = 0
    let pending: SearchDocument<M>[] = []
    for await (const document of source()) {
      pending.push(document)
      if (pending.length >= batch) {
        await this.upsertMany(pending)
        indexed += pending.length
        pending = []
      }
    }
    await this.upsertMany(pending)
    indexed += pending.length
    const removed = await this.db.exec(sql`delete from ${TABLE} where index = ${this.name} and updated_at < ${started}`)
    return { indexed, removed }
  }
}

/**
 * Define an index (usually in `app/search/`, where `cslug search:reindex` finds it): `searchIndex('help',
 * { languages: ['french', 'english'], documents: async function* () { … } })`. One definition per name.
 */
export function searchIndex<M extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  options: SearchIndexOptions<M> = {},
): SearchIndex<M> {
  if (registry.has(name)) throw new Error(`searchIndex('${name}') is defined twice`)
  const index = new SearchIndex<M>(name, options)
  registry.set(name, index as unknown as SearchIndex<Record<string, unknown>>)
  return index
}

/** The indexes defined so far (after `discoverSearchIndexes` imported `app/search/`). */
export const searchIndexes = (): SearchIndex[] => [...registry.values()]

/** Import every module under `app/search/`, so their `searchIndex()` definitions run. */
export async function discoverSearchIndexes(app: Application): Promise<void> {
  const dir = join(app.rootDir, 'app/search')
  if (!existsSync(dir)) return
  for (const file of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /(?<!\.test)\.ts$/.test(f)))
    await import(join(dir, file))
}
