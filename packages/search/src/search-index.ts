import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Application, Clock, CslugError, currentApp, resolve } from '@cslug/core'
import { Database, type Page, sql } from '@cslug/database'
import { Embedder } from './embedder'

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
  /**
   * Also search by meaning: each document's title and body (the first `maxChars`, default 8000) are embedded on
   * upsert with the bound `Embedder` (needs `search.vectors: true` and pgvector). Unchanged texts are not embedded
   * again. Searches are then hybrid by default.
   */
  semantic?: boolean | { maxChars?: number }
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
  /** Also match titles similar to the term (pg_trgm), ranked lower (text and hybrid modes). */
  typos?: boolean
  /**
   * `text`: words (full text). `semantic`: meaning (nearest embeddings; rank = cosine similarity). `hybrid`: both,
   * merged by reciprocal rank fusion. Default: `hybrid` for a `semantic` index, else `text`.
   */
  mode?: 'text' | 'semantic' | 'hybrid'
  /** Semantic and hybrid: leave out documents less similar than this (0–1, default 0). */
  minSimilarity?: number
}

const TABLE = sql`cslug_search_documents`
const EMBEDDINGS = sql`cslug_search_embeddings`
/** How many results of each ranking a hybrid search fuses, and the reciprocal-rank-fusion constant. */
const FUSE = { depth: 100, k: 60 }
const vectorLiteral = (v: number[]) => `[${v.join(',')}]`
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
    if (this.options.semantic) await this.embed(documents)
  }

  private embedder(): Embedder {
    if (!currentApp().has(Embedder))
      throw new CslugError(
        'search.no_embedder',
        `Index ${this.name} is semantic but no Embedder is bound: configure ai.embeddings (@cslug/ai) or bind one`,
      )
    return resolve(Embedder)
  }

  /** Queries on `cslug_search_embeddings`, with a hint when its migration is missing. */
  private async vectors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (String((error as Error)?.message).includes('cslug_search_embeddings'))
        throw new CslugError(
          'search.no_vectors',
          'Semantic search needs the embeddings table: set `vectors: true` in config/search.ts and run cslug migrate (needs pgvector)',
        )
      throw error
    }
  }

  /** Embed the documents whose text (or the embedder's model) changed since their last embedding. */
  private async embed(documents: SearchDocument<M>[]): Promise<void> {
    const embedder = this.embedder()
    const max = (typeof this.options.semantic === 'object' && this.options.semantic.maxChars) || 8000
    const texts = new Map(
      documents.map((d) => [d.key, `${d.title ?? ''}\n\n${d.body ?? ''}`.slice(0, max).trim()] as const),
    )
    const hashOf = (text: string) => new Bun.CryptoHasher('sha1').update(text).digest('hex')
    await this.vectors(async () => {
      const known = await this.db.many<{ key: string; hash: string }>(
        sql`select key, hash from ${EMBEDDINGS} where index = ${this.name} and model = ${embedder.model}
          and key in (${sql.join([...texts.keys()])})`,
      )
      const done = new Map(known.map((k) => [k.key, k.hash]))
      const changed = [...texts].filter(([key, text]) => done.get(key) !== hashOf(text))
      for (let i = 0; i < changed.length; i += 64) {
        const chunk = changed.slice(i, i + 64)
        const vectors = await embedder.embed(
          chunk.map(([, text]) => text),
          'document',
        )
        const rows = chunk.map(
          ([key, text], n) =>
            sql`(${this.name}, ${key}, ${embedder.model}, ${hashOf(text)}, ${vectorLiteral(vectors[n] as number[])}::vector)`,
        )
        await this.db.exec(sql`insert into ${EMBEDDINGS} (index, key, model, hash, embedding) values ${sql.join(rows)}
          on conflict (index, key) do update set model = excluded.model, hash = excluded.hash,
            embedding = excluded.embedding`)
      }
    })
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

  /** The best matches for `term` (web-search syntax in text mode), as a page. */
  async search(term: string, options: IndexSearchOptions<M> = {}): Promise<Page<SearchHit<M>>> {
    const { page = 1, perPage = 20, minSimilarity = 0 } = options
    const blank = !/\w/.test(term)
    const mode = blank ? 'text' : (options.mode ?? (this.options.semantic ? 'hybrid' : 'text'))
    if (mode !== 'text' && !this.options.semantic)
      throw new CslugError(
        'search.not_semantic',
        `Index ${this.name} is not semantic: define it with { semantic: true }`,
      )
    const configs = options.language === undefined ? this.configs : [this.config(options.language)]
    const tsquery = sql`(${sql.join(
      configs.map((c) => sql`websearch_to_tsquery(${quoted(c)}::regconfig, ${term})`),
      sql` || `,
    )})`
    const match = blank
      ? sql`true`
      : options.typos
        ? sql`(d.vector @@ ${tsquery} or ${term} <% d.title)`
        : sql`d.vector @@ ${tsquery}`
    const textRank = options.typos
      ? sql`(ts_rank_cd(d.vector, ${tsquery}, 32) + 0.3 * word_similarity(${term}, d.title))::float8`
      : sql`ts_rank_cd(d.vector, ${tsquery}, 32)::float8`
    const filter = options.filter ? sql` and d.metadata @> ${sql.json(options.filter)}` : sql.empty
    const h = options.highlight
    const { words = 30, fragments = 2 } = typeof h === 'object' ? h : {}
    const settings = quoted(
      `StartSel=<mark>, StopSel=</mark>, MaxWords=${words}, MinWords=${Math.max(1, Math.min(10, words - 1))}, ` +
        `MaxFragments=${fragments}, FragmentDelimiter=" … "`,
    )
    const highlight = h
      ? sql`, json_build_object('title', ts_headline(d.config, ${escapeHtml(sql`d.title`)}, ${tsquery}, ${settings}),
          'body', ts_headline(d.config, ${escapeHtml(sql`d.body`)}, ${tsquery}, ${settings})) as highlight`
      : sql.empty
    const p = Math.max(1, Math.floor(page))
    const window = sql`limit ${perPage} offset ${(p - 1) * perPage}`
    const pageOf = (data: SearchHit<M>[], total: number) => ({
      data,
      meta: { page: p, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)) },
    })

    if (mode === 'text') {
      const where = sql`where d.index = ${this.name} and ${match}${filter}`
      const total = Number(await this.db.value(sql`select count(*)::int from ${TABLE} d ${where}`))
      const data = await this.db.many<SearchHit<M>>(
        sql`select d.key, d.title, d.metadata, ${textRank} as rank${highlight} from ${TABLE} d ${where}
          order by rank desc, d.key ${window}`,
      )
      return pageOf(data, total)
    }

    const embedder = this.embedder()
    const [vector] = await embedder.embed([term], 'query')
    const v = sql`${vectorLiteral(vector as number[])}::vector`
    const nearest = sql`${TABLE} d join ${EMBEDDINGS} e on e.index = d.index and e.key = d.key and e.model = ${embedder.model}
      where d.index = ${this.name} and 1 - (e.embedding <=> ${v}) >= ${minSimilarity}${filter}`
    return this.vectors(async () => {
      if (mode === 'semantic') {
        const total = Number(await this.db.value(sql`select count(*)::int from ${nearest}`))
        const data = await this.db.many<SearchHit<M>>(
          sql`select d.key, d.title, d.metadata, (1 - (e.embedding <=> ${v}))::float8 as rank${highlight}
            from ${nearest} order by e.embedding <=> ${v}, d.key ${window}`,
        )
        return pageOf(data, total)
      }
      // hybrid: the best `depth` of each ranking, fused by reciprocal rank (Σ 1 / (k + position))
      const fused = sql`with words as (
          select d.key, row_number() over (order by ${textRank} desc, d.key) as position from ${TABLE} d
          where d.index = ${this.name} and ${match}${filter} order by position limit ${FUSE.depth}
        ), meaning as (
          select d.key, row_number() over (order by e.embedding <=> ${v}, d.key) as position from ${nearest}
          order by position limit ${FUSE.depth}
        ), fused as (
          select key, sum(1.0 / (${FUSE.k} + position))::float8 as score
          from (select * from words union all select * from meaning) x group by key
        )`
      const total = Number(await this.db.value(sql`${fused} select count(*)::int from fused`))
      const data = await this.db.many<SearchHit<M>>(
        sql`${fused} select d.key, d.title, d.metadata, fused.score as rank${highlight}
          from fused join ${TABLE} d on d.index = ${this.name} and d.key = fused.key
          order by fused.score desc, d.key ${window}`,
      )
      return pageOf(data, total)
    })
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
