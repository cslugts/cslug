import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, flag, names } from '@cslug/core'
import { Database } from './database'
import {
  type Change,
  diffSchemas,
  introspect,
  loadTables,
  migrationSql,
  type RenameCandidate,
  renameCandidates,
  tableSpec,
} from './differ'
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
  /** Diff `app/tables/` against the database, asking about possible renames; prints each change. */
  protected async schemaChanges(): Promise<Change[]> {
    const desired = (await loadTables(this.app.rootDir)).map(tableSpec)
    const actual = await introspect(this.app.resolve(Database))
    const renames: RenameCandidate[] = []
    for (const c of renameCandidates(desired, actual)) {
      const answer = await this.choose(`${c.table}.${c.from} → ${c.to}: rename or drop+add?`, ['rename', 'drop+add'])
      if (answer === 'rename') renames.push(c)
    }
    const changes = diffSchemas(desired, actual, renames)
    for (const change of changes) {
      this.line(`  ${change.label}`)
      if (change.warning) this.warn(change.warning)
    }
    return changes
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

const stamp = (now: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

/**
 * `cslug make:migration add_claims_index` → an empty `database/migrations/<stamp>_add_claims_index.sql`;
 * `cslug make:migration --from-tables` → the SQL that brings the database to `app/tables/` (renames are asked).
 */
export class MakeMigrationCommand extends DatabaseCommand {
  static signature = 'make:migration'
  static description = 'Create a SQL migration: empty, or --from-tables (diff app/tables against the database)'
  static boot = false
  static args = {
    name: arg.string().optional().describe('snake_case, e.g. create_claims'),
    fromTables: flag.boolean().describe('Write the SQL for what app/tables changed'),
  }

  async handle({ name, fromTables }: Command.Args<typeof MakeMigrationCommand>) {
    if (!fromTables) {
      if (!name) {
        this.error('A name, or --from-tables')
        return 2
      }
      const snakeName = names(name).snake
      const table = /^create_(\w+)$/.exec(snakeName)?.[1]
      const target = `database/migrations/${stamp(this.clock.now())}_${snakeName}.sql`
      const stub = table ? 'migration.create.stub' : 'migration.stub'
      return this.generate(STUBS, stub, target, { table: table ?? '' }) ? 0 : 1
    }
    await this.app.start()
    const changes = await this.schemaChanges()
    if (!changes.length) {
      this.info('Nothing to migrate: the database matches app/tables')
      return 0
    }
    const tables = [...new Set(changes.map((c) => c.table))]
    const created = changes.every((c) => c.label.startsWith('+ table'))
    const fallback = tables.length === 1 ? `${created ? 'create' : 'update'}_${tables[0]}` : 'update_schema'
    const file = `database/migrations/${stamp(this.clock.now())}_${names(name ?? fallback).snake}.sql`
    const review = changes.filter((c) => c.warning).map((c) => `-- review: ${c.warning}\n`)
    mkdirSync(join(this.app.rootDir, 'database/migrations'), { recursive: true })
    writeFileSync(join(this.app.rootDir, file), `${review.join('')}${migrationSql(changes)}`)
    this.success(file)
    return 0
  }
}

/**
 * `cslug db:shell`: `psql` on the app's database (`config database.url`). The password goes through `PGPASSWORD`,
 * never the command line (where `ps` shows it). `--command` runs one statement and exits.
 */
export class DbShellCommand extends Command {
  static signature = 'db:shell'
  static description = 'Open psql on the app database'
  static boot = false
  static args = { command: flag.string().optional().alias('c').describe('Run one SQL statement and exit') }

  async handle({ command }: Command.Args<typeof DbShellCommand>) {
    const configured = this.app.config<string | undefined>('database.url')
    if (!configured) {
      this.error('No database configured (config/database.ts → url)')
      return 1
    }
    const psql = Bun.which('psql')
    if (!psql) {
      this.error('psql is not installed (Debian/Ubuntu: apt install postgresql-client; macOS: brew install libpq)')
      return 1
    }
    const url = new URL(configured)
    const password = decodeURIComponent(url.password)
    url.password = ''
    const proc = Bun.spawn([psql, url.toString(), ...(command ? ['-c', command] : [])], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
    })
    return await proc.exited
  }
}

/** `cslug db:diff`: what `make:migration --from-tables` would write, without writing it. */
export class DbDiffCommand extends DatabaseCommand {
  static signature = 'db:diff'
  static description = 'Show the drift between app/tables and the database (writes nothing)'
  static args = { sql: flag.boolean().describe('Print the SQL too') }

  async handle({ sql }: Command.Args<typeof DbDiffCommand>) {
    const changes = await this.schemaChanges()
    if (!changes.length) this.info('No drift: the database matches app/tables')
    else if (sql) this.line(`\n${migrationSql(changes)}`)
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
  DbDiffCommand,
  DbShellCommand,
  make('table', 'app/tables'),
  make('repository', 'app/repositories'),
  make('factory', 'database/factories'),
  make('seeder', 'database/seeders'),
]
