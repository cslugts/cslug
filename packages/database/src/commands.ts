import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, flag, names } from '@cslug/core'
import { Database } from './database'
import { isSeeder } from './factory'
import { Migrator } from './migrator'

const STUBS = join(import.meta.dir, '../stubs')

abstract class DatabaseCommand extends Command {
  protected migrator(): Migrator {
    return new Migrator(this.app.resolve(Database), {
      paths: [join(this.app.rootDir, 'database/migrations')],
      env: String(this.app.config('app.env') ?? 'development'),
      log: this.log,
    })
  }
  protected get production(): boolean {
    return this.app.config('app.env') === 'production'
  }
  /** Destructive commands in production need `--force`. */
  protected guard(force: boolean, what: string): boolean {
    if (this.production && !force) {
      this.error(`${what} in production: add --force if you really mean it`)
      return false
    }
    return true
  }
  protected async seed(only?: string): Promise<number> {
    const dir = join(this.app.rootDir, 'database/seeders')
    if (!existsSync(dir)) {
      this.warn('No database/seeders folder')
      return 0
    }
    // database-seeder.ts runs alone (it calls the others) unless one is named
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    const chosen = only
      ? files.filter((f) => f === `${names(only, 'seeder').file}.ts` || f === `${only}.ts`)
      : files.includes('database-seeder.ts')
        ? ['database-seeder.ts']
        : files.sort()
    if (!chosen.length) {
      this.error(`No seeder ${only}`)
      return 1
    }
    for (const f of chosen) {
      const mod = await import(join(dir, f))
      if (!isSeeder(mod.default)) throw new Error(`${f} must \`export default seeder(async () => { … })\``)
      await this.app.resolve(Database).transaction(() => mod.default.run())
      this.success(`seeded ${f.replace(/\.ts$/, '')}`)
    }
    return 0
  }
}

/** `cslug migrate`: run pending migrations (advisory-locked: concurrent runs execute each once). */
export class MigrateCommand extends DatabaseCommand {
  static signature = 'migrate'
  static description = 'Run pending migrations'
  static args = {
    seed: flag.boolean().describe('Run the seeders afterwards'),
    force: flag.boolean().describe('Required with --seed in production'),
  }

  async handle({ seed, force }: Command.Args<typeof MigrateCommand>) {
    const ran = await this.migrator().migrate()
    if (!ran.length) this.info('Nothing to migrate')
    for (const name of ran) this.success(name)
    if (seed) return this.guard(force, 'Seeding') ? this.seed() : 1
  }
}

export class MigrateStatusCommand extends DatabaseCommand {
  static signature = 'migrate:status'
  static description = 'Which migrations ran, in which batch'
  static args = { json: flag.boolean() }

  async handle({ json }: Command.Args<typeof MigrateStatusCommand>) {
    const status = await this.migrator().status()
    if (json) return this.line(JSON.stringify(status))
    this.table(
      status.map((s) => ({ migration: s.name, ran: s.ran ? 'yes' : 'pending', batch: s.batch ?? '', at: s.ranAt })),
    )
  }
}

export class MigrateRollbackCommand extends DatabaseCommand {
  static signature = 'migrate:rollback'
  static description = 'Roll back the last batch (or --step n migrations)'
  static args = { step: flag.number().optional().describe('Number of migrations'), force: flag.boolean() }

  async handle({ step, force }: Command.Args<typeof MigrateRollbackCommand>) {
    if (!this.guard(force, 'Rolling back')) return 1
    const rolled = await this.migrator().rollback({ steps: step })
    if (!rolled.length) this.info('Nothing to roll back')
    for (const name of rolled) this.success(`rolled back ${name}`)
  }
}

export class MigrateFreshCommand extends DatabaseCommand {
  static signature = 'migrate:fresh'
  static description = 'Drop every table and migrate from scratch (refused in production)'
  static args = { seed: flag.boolean().describe('Run the seeders afterwards') }

  async handle({ seed }: Command.Args<typeof MigrateFreshCommand>) {
    if (this.production) {
      this.error('migrate:fresh drops every table; it is refused in production')
      return 1
    }
    for (const name of await this.migrator().fresh()) this.success(name)
    if (seed) return this.seed()
  }
}

export class DbSeedCommand extends DatabaseCommand {
  static signature = 'db:seed'
  static description = 'Run database/seeders/database-seeder.ts (or the one named)'
  static args = {
    seeder: arg.string().optional().describe('e.g. pilot (database/seeders/pilot-seeder.ts)'),
    force: flag.boolean(),
  }

  handle({ seeder, force }: Command.Args<typeof DbSeedCommand>) {
    return this.guard(force, 'Seeding') ? this.seed(seeder) : 1
  }
}

/** `cslug make:migration add_claims_index` → database/migrations/20261126_101500_add_claims_index.sql. */
export class MakeMigrationCommand extends Command {
  static signature = 'make:migration'
  static description = 'Create an empty SQL migration'
  static boot = false
  static args = { name: arg.string().describe('snake_case, e.g. create_claims') }

  handle({ name }: Command.Args<typeof MakeMigrationCommand>) {
    const now = this.clock.now()
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    const snakeName = names(name).snake
    const table = /^create_(\w+)$/.exec(snakeName)?.[1]
    return this.generate(
      STUBS,
      table ? 'migration.create.stub' : 'migration.stub',
      `database/migrations/${stamp}_${snakeName}.sql`,
      { table: table ?? '' },
    )
      ? 0
      : 1
  }
}

const makeArgs = { name: arg.string().describe('e.g. Claim'), force: flag.boolean() }
const make = (kind: 'table' | 'repository' | 'factory' | 'seeder', dir: string) =>
  class extends Command {
    static signature = `make:${kind}`
    static description = `Create a ${kind}`
    static boot = false
    static args = makeArgs
    handle({ name, force }: Command.Args<{ args: typeof makeArgs }>) {
      const n = names(name, kind)
      const plural = n.snake.endsWith('s') ? n.snake : `${n.snake}s`
      const tableName = names(name, 'table')
      return this.generate(
        STUBS,
        `${kind}.stub`,
        `${dir}/${n.file}.ts`,
        { ...n, plural, tableVar: `${tableName.camel}s`.replace(/ss$/, 's'), tableFile: tableName.file },
        force,
      )
        ? 0
        : 1
    }
  }

export const databaseCommands = [
  MigrateCommand,
  MigrateStatusCommand,
  MigrateRollbackCommand,
  MigrateFreshCommand,
  DbSeedCommand,
  MakeMigrationCommand,
  make('table', 'app/tables'),
  make('repository', 'app/repositories'),
  make('factory', 'database/factories'),
  make('seeder', 'database/seeders'),
]
