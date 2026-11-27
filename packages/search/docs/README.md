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

## Not yet

`SearchIndex` (documents that are not rows) and `cslug search:reindex`, semantic search with pgvector and an
`Embedder`, hybrid ranking, and the AI search tool come in the next parts of M10.
