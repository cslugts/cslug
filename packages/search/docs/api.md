# @cslug/search: API

| | |
|---|---|
| `searchable(weights, options?)` | A hidden, generated `tsvector` column: `weights` `{ column: 'A' \| 'B' \| 'C' \| 'D' }`; `options.language` a configuration name or `{ column, configs, fallback? }`; `options.unaccent` (default true: `cslug_<config>`) |
| `search(source, term, options?)` | `source` a repository or a `Query`; → `Query<T, R & { rank: number } & { highlight?: Record<K, string> }>`. Options: `column`, `language`, `highlight` (`K[]` or `{ columns, words?, fragments? }`), `typos` (`K[]`) |
| `searchColumnOf(table, key?)` | `{ key, config }` of the table's `searchable()` column; an error names what is missing or ambiguous |
| `searchIndex<M>(name, options?)` → `SearchIndex<M>` | A document index (defined once per name): `options.languages` (first = default), `unaccent`, `documents()` (a sync or async iterable of `SearchDocument<M>`) |
| `SearchIndex` | `upsert(doc)`, `upsertMany(docs)`, `remove(...keys)` → count, `clear()` → count, `count()`, `search(term, { page, perPage, filter, language, highlight, typos })` → `Page<SearchHit<M>>`, `reindex(batch?)` → `{ indexed, removed }` |
| `SearchDocument<M>` / `SearchHit<M>` | `{ key, title?, body?, metadata?, language? }` / `{ key, title, metadata, rank, highlight? }` |
| `searchIndexes()`, `discoverSearchIndexes(app)` | The indexes defined so far; import `app/search/` |
| `SearchReindexCommand` | `cslug search:reindex [index]` |
| `SearchProvider` | Registers the `cslug_search` migrations; contributes `search:reindex` |
| `SEARCH_MIGRATIONS` | Its folder: `unaccent`, `pg_trgm`, `cslug_<config>` text search configurations (down drops the configurations, not the extensions); `cslug_search_documents` |
| `Weights`, `Language`, `SearchableOptions`, `SearchOptions`, `SearchConfig` | Types |
