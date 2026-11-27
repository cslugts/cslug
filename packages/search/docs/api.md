# @cslug/search: API

| | |
|---|---|
| `searchable(weights, options?)` | A hidden, generated `tsvector` column: `weights` `{ column: 'A' \| 'B' \| 'C' \| 'D' }`; `options.language` a configuration name or `{ column, configs, fallback? }`; `options.unaccent` (default true: `cslug_<config>`) |
| `search(source, term, options?)` | `source` a repository or a `Query`; → `Query<T, R & { rank: number } & { highlight?: Record<K, string> }>`. Options: `column`, `language`, `highlight` (`K[]` or `{ columns, words?, fragments? }`), `typos` (`K[]`) |
| `searchColumnOf(table, key?)` | `{ key, config }` of the table's `searchable()` column; an error names what is missing or ambiguous |
| `SearchProvider` | Registers the `cslug_search` migration |
| `SEARCH_MIGRATIONS` | Its folder: `unaccent`, `pg_trgm`, `cslug_<config>` text search configurations (down drops the configurations, not the extensions) |
| `Weights`, `Language`, `SearchableOptions`, `SearchOptions`, `SearchConfig` | Types |
