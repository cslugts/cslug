# @cslug/search

`cslug add search` installs the package and lists `SearchProvider`; `cslug migrate` then runs its migration before
the app's: the `unaccent` and `pg_trgm` extensions (both trusted: the database owner can create them) and a copy of
every built-in text search configuration that ignores accents, `cslug_<name>` (`cslug_french`, `cslug_english`,
`cslug_simple`…: `unaccent`, then the language's dictionary).

## A search column

```ts
export const circuits = table('circuits', {
  id: id(),
  title: text(),
  summary: text().nullable(),
  body: text(),
  search: searchable({ title: 'A', summary: 'B', body: 'C' }, { language: 'french' }),
}, { indexes: (t) => [t.using('gin', 'search'), t.using('gin', ['title', 'gin_trgm_ops'])] })
```

`searchable(weights, { language, unaccent })` is a hidden generated `tsvector` column (`@cslug/database`'s
`generatedAs` + `hidden`): PostgreSQL computes it on every insert and update, rows never carry it, and
`cslug make:migration --from-tables` creates it (and follows weight or language changes). Weights are `A` (most) to
`D`. Index it with `t.using('gin', 'search')`.

- `language: 'french'`: a fixed text search configuration (default `simple`: no stemming).
- `language: { column: 'locale', configs: { fr: 'french', en: 'english', it: 'italian' }, fallback: 'simple' }`: each
  row is stemmed in its own language (a `case` on the column; values without a configuration use the fallback).
- `unaccent: false`: use the configurations as they are (accents matter).

## Searching

```ts
const page = await search(this.circuits, 'isalo 4x4', { highlight: ['summary'], typos: ['title'] })
  .where({ published: true })
  .paginate(1, 20)
// page.data: (Row & { rank: number; highlight: { summary: string } })[]
```

`search(repoOrQuery, term, options)` returns the query with the rows that match, best first:

- **Syntax** (`websearch_to_tsquery`): words (all must match), `"an exact phrase"`, `-without`, `or`. A term without
  any word filters nothing (every row, `rank` 0).
- **Rank**: `ts_rank_cd(vector, query, 32)`, between 0 and 1, so title (A) matches come before body (C) ones. The
  rank is the first sort term: `orderBy` added after `search()` breaks ties.
- **Languages**: the query is built for every language of the column at once (a row matches in its own);
  `language: 'fr'` (a value) or `'french'` (a configuration) searches one.
- **Highlights**: `highlight: ['summary']` (or `{ columns, words = 30, fragments = 2 }`) adds `highlight.<column>`:
  the text HTML-escaped, then the matching words in `<mark>…</mark>` (safe to render as HTML). Fragments start and end
  at words that are not stop words; `fragments: 0` gives one window from the start of the text instead.
- **Typos**: `typos: ['title']` also matches rows whose column is similar to the term (`pg_trgm` word similarity, so
  `isallo` finds `Isalo`); they rank lower (`+ 0.3 × similarity`). Each column needs `t.using('gin', [column,
  'gin_trgm_ops'])`.
- `column` picks the search column when a table has several.

Everything is a `whereSql`, `selectSql` and `orderBySql` on the query, so it composes with the rest of the query builder
(`where`, `paginate`, `first`, `cursor` on another key is not meaningful with a rank).

## Indexes for documents that are not rows

```ts
// app/search/help-search-index.ts
export const helpIndex = searchIndex<{ url: string; kind: 'faq' | 'guide' }>('help', {
  languages: ['french', 'english'],                 // the first is the default
  documents: async function* () {                   // what `cslug search:reindex help` refills it with
    for (const page of await resolve(HelpPageRepository).all())
      yield { key: page.slug, title: page.title, body: page.text, language: page.locale === 'en' ? 'english' : 'french',
              metadata: { url: `/help/${page.slug}`, kind: page.kind } }
  },
})

await helpIndex.upsert({ key: 'visa', title: 'Visa à l’arrivée', body, metadata: { url: '/help/visa', kind: 'faq' } })
const { data, meta } = await helpIndex.search('visa', { filter: { kind: 'faq' }, highlight: true, page: 1 })
// data: { key, title, metadata, rank, highlight?: { title, body } }[]
```

Documents live in `cslug_search_documents` (one row per index and key: title, body, metadata, its text search
configuration, and a vector generated from the title (A) and the body (B) in that language). A document's
`language` must be one of the index's `languages`; the query covers them all unless `language` narrows it.

- `upsert(doc)` / `upsertMany(docs)` add or replace by key (one statement); `remove(...keys)`, `clear()`, `count()`.
- `search(term, { page = 1, perPage = 20, filter, language, highlight, typos })` → `{ data, meta }` like
  `paginate()`: ranked as `search()` ranks rows, `filter` matches metadata (`metadata @> filter`), `highlight`
  (`true` or `{ words, fragments }`) marks the title and body (HTML-escaped first), `typos` also matches similar
  titles.
- `reindex()` (and `cslug search:reindex [name]`, which imports `app/search/`): upserts everything `documents()`
  yields, in batches of 500, then removes the documents it did not yield. Without a name, every index that has a
  source. Indexes are defined once per name (`searchIndex()` throws on a second definition).

Table search never needs a reindex: PostgreSQL computes `searchable()` columns on every write.

## Semantic and hybrid search

```ts
// config/search.ts
export default defineConfig({ vectors: true })     // registers the embeddings migration: pgvector, then cslug migrate

export const helpIndex = searchIndex('help', { languages: ['french', 'english'], semantic: true })
await helpIndex.search('louer une voiture')                       // hybrid (the default for a semantic index)
await helpIndex.search('louer une voiture', { mode: 'semantic', minSimilarity: 0.3 })
```

- **Embeddings.** A `semantic` index embeds each document's title and body (the first `maxChars`, default 8000:
  `semantic: { maxChars }`) on `upsert`, with the app's `Embedder`, into `cslug_search_embeddings` (one vector per
  document, deleted with it). A document is embedded again only when its text or the embedder's `model` changed (a
  hash is kept), so `search:reindex` costs nothing for unchanged documents. Vectors of another model are ignored
  until the document is embedded again.
- **Modes.** `text` (full text, as before), `semantic` (nearest vectors by cosine distance; `rank` is the cosine
  similarity, `minSimilarity` leaves out the rest; the query is embedded with `purpose: 'query'`), `hybrid`
  (the best 100 of each, fused by reciprocal rank: `Σ 1 / (60 + position)`; a document found both ways comes first).
  `filter`, `highlight` (on the words of the term) and pagination work in every mode.
- **The `Embedder`** is a contract: `model` and `embed(texts, purpose)`. `@cslug/ai` will provide drivers
  (OpenAI-compatible, Voyage); tests and development can bind `FakeEmbedder` (`app.instance(Embedder, new
  FakeEmbedder())`): words hashed into buckets, plus optional `concepts` to show matches by meaning.
- The search is exact (no approximate index): fine for thousands of documents. pgvector's `vector` extension may
  need a superuser to install on some hosts.
- Table rows are searched by meaning through an index: upsert the rows' text into a semantic `searchIndex()` where
  they change (or from its `documents()` source).

## Not yet

The embedding drivers in `@cslug/ai` and the AI search tool come in the next parts of M10.
