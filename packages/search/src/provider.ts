import { ServiceProvider } from '@cslug/core'
import { addMigrations } from '@cslug/database'
import { SEARCH_MIGRATIONS } from './searchable'

/**
 * Registers the `cslug_search` migration (`cslug migrate` runs it before the app's own): the `unaccent` and
 * `pg_trgm` extensions and the accent-insensitive `cslug_<config>` text search configurations.
 */
export class SearchProvider extends ServiceProvider {
  register() {
    addMigrations(SEARCH_MIGRATIONS)
  }
}
