import { arg, Command, ServiceProvider } from '@cslug/core'
import { addMigrations } from '@cslug/database'
import { discoverSearchIndexes, searchIndexes } from './search-index'
import { SEARCH_MIGRATIONS, VECTOR_MIGRATIONS } from './searchable'

/**
 * `cslug search:reindex [index]`: refill the indexes defined in `app/search/` from their `documents()` source (all of
 * them, or one). Table search needs no reindex: PostgreSQL keeps `searchable()` columns up to date.
 */
export class SearchReindexCommand extends Command {
  static signature = 'search:reindex'
  static description = 'Refill search indexes (app/search/) from their documents() source'
  static args = { index: arg.string().optional().describe('One index by name; default: every index with a source') }

  async handle({ index }: Command.Args<typeof SearchReindexCommand>) {
    await discoverSearchIndexes(this.app)
    const all = searchIndexes()
    const chosen = index ? all.filter((i) => i.name === index) : all.filter((i) => i.options.documents)
    if (index && !chosen.length) {
      this.error(`No index "${index}" in app/search/ (indexes: ${all.map((i) => i.name).join(', ') || 'none'})`)
      return 1
    }
    if (!chosen.length) {
      this.info('No index with a documents() source in app/search/')
      return 0
    }
    for (const i of chosen) {
      const { indexed, removed } = await i.reindex()
      this.success(`${i.name}: ${indexed} indexed, ${removed} removed`)
    }
    return 0
  }
}

/**
 * Registers the `cslug_search` migrations (`cslug migrate` runs them before the app's own): the `unaccent` and
 * `pg_trgm` extensions, the accent-insensitive `cslug_<config>` text search configurations, and
 * `cslug_search_documents` for `searchIndex()`; with `search.vectors: true` (config/search.ts), pgvector and
 * `cslug_search_embeddings` for semantic indexes. Contributes `search:reindex`.
 */
export class SearchProvider extends ServiceProvider {
  register() {
    addMigrations(SEARCH_MIGRATIONS)
    if (this.app.config<boolean | undefined>('search.vectors')) addMigrations(VECTOR_MIGRATIONS)
    this.commands([SearchReindexCommand])
  }
}
