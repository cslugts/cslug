import { Logger, ServiceProvider } from '@cslug/core'
import { Database, type DatabaseConfig } from './database'

/** Binds `Database` from `config('database')`, checks the connection at boot, closes the pool at shutdown. */
export class DatabaseProvider extends ServiceProvider {
  register() {
    this.app.singleton(Database, (c) => {
      const config = this.app.config<DatabaseConfig | undefined>('database')
      if (!config?.url) throw new Error('config/database.ts must define `url` (usually env.DATABASE_URL)')
      return new Database(config, c.resolve(Logger))
    })
  }

  async boot() {
    await this.app.resolve(Database).ping()
  }

  async shutdown() {
    await this.app.resolve(Database).close()
  }
}
