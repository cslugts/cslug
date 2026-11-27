# Search

`@cslug/search` searches the text the app already keeps in PostgreSQL: circuit pages, operators, FAQs. No search
server, no sync job: PostgreSQL keeps the search column up to date on every write.

```bash
cslug add search && cslug migrate
```

## Making a table searchable

```ts
// app/tables/circuit-table.ts
export const circuits = table('circuits', {
  id: id(),
  locale: text().oneOf(['fr', 'en', 'it']),
  title: text(),
  summary: text().nullable(),
  body: text(),
  published: boolean().default(false),
  search: searchable(
    { title: 'A', summary: 'B', body: 'C' },
    { language: { column: 'locale', configs: { fr: 'french', en: 'english', it: 'italian' } } },
  ),
}, { indexes: (t) => [t.using('gin', 'search'), t.using('gin', ['title', 'gin_trgm_ops'])] })
```

`cslug make:migration --from-tables` writes the column (generated from the weighted columns) and the indexes. Each
row is stemmed in its own language, and accents are ignored: `foret` finds `forêt`, `randonnee` finds `randonnées`.

## Searching

```ts
async index({ request }: HttpContext) {
  const { q, page } = await request.validate(v.object({ q: v.string().max(100), page: v.int().min(1).default(1) }))
  return search(this.circuits, q, { highlight: ['summary'], typos: ['title'] })
    .where({ published: true })
    .paginate(page, 20)
}
```

- The term uses web-search syntax: `isalo 4x4`, `"forêt de pierre"`, `baobab or tsingy`, `isalo -voiture`.
- Rows come best first, with their `rank` (0–1); title matches outrank body matches.
- `highlight.summary` is the summary, HTML-escaped, with the matching words in `<mark>`: render it with `v-html`.
- `typos: ['title']` finds `Isalo` for `isallo` (ranked lower than exact matches).
- It is a query: add `where`, `orderBy` (after the rank), `paginate`.

Coming next: an index for documents that are not table rows, semantic search (by meaning, with pgvector), and a
search tool for agents.
