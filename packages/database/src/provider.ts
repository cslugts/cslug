import { Encrypter, HEALTH_CHECKS, healthCheck, Logger, ServiceProvider } from '@cslug/core'
import { databaseCommands } from './commands'
import { Database, type DatabaseConfig } from './database'
import { loadTables } from './differ'
import { setEncrypter } from './encryption'

/** The tables exported by `app/tables/*.ts` (`cslug describe tables`): columns, keys, indexes, references. */
export async function describeTables(rootDir: string) {
  const tables = await loadTables(rootDir)
  return tables.map((t) => ({
    name: t.name,
    primaryKey: t.primaryKey,
    columns: Object.entries(t.columns).map(([key, { def }]) => ({
      name: t.sqlNames.get(key),
      key,
      type: def.sqlType,
      nullable: def.nullable,
      ...(def.unique ? { unique: true } : {}),
      ...(def.oneOf ? { oneOf: def.oneOf } : {}),
      ...(def.defaultSql ? { default: def.defaultSql } : {}),
      ...(def.references ? { references: `${def.references.table().name}.${def.references.column}` } : {}),
      ...(def.generated ? { generated: true } : {}),
      ...(def.hidden ? { hidden: true } : {}),
    })),
    indexes: t.indexes,
  }))
}

/** Binds `Database` from `config('database')`, checks the connection at boot, closes the pool at shutdown. */
export class DatabaseProvider extends ServiceProvider {
  register() {
    this.commands(databaseCommands)
    this.describe('tables', () => describeTables(this.app.rootDir))
    setEncrypter(() => this.app.resolve(Encrypter))
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
