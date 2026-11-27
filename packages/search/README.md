# @cslug/search

Full-text search over any table, on PostgreSQL (no search server): `searchable()` declares a weighted, multilingual,
accent-insensitive search column that PostgreSQL keeps up to date, and `search()` runs ranked queries with highlights
and typo tolerance that compose with the query builder. List `SearchProvider` in `bootstrap/providers.ts`
(`cslug add search`), then `cslug migrate`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 22](../../guides/22-search.md).
