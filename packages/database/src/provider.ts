import { HEALTH_CHECKS, healthCheck, Logger, ServiceProvider } from '@cslug/core'
import { Database, type DatabaseConfig } from './database'
import { setEncryptionKey } from './encryption'

/** Binds `Database` from `config('database')`, checks the connection at boot, closes the pool at shutdown. */
export class DatabaseProvider extends ServiceProvider {
  register() {
    setEncryptionKey(this.app.config<string | undefined>('app.key'))
    this.app.singleton(Database, (c) => {
      const config = this.app.config<DatabaseConfig | undefined>('database')
      if (!config?.url) throw new Error('config/database.ts must define `url` (usually env.DATABASE_URL)')
      return new Database(config, c.resolve(Logger))
    })
    const check = healthCheck('database')
    this.app.singleton(check, (c) => ({ name: 'database', check: () => c.resolve(Database).ping() }))
    this.app.tag([check], HEALTH_CHECKS)
  }

  async boot() {
    await this.app.resolve(Database).ping()
  }

  async shutdown() {
    await this.app.resolve(Database).close()
  }
}
