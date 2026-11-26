import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CslugError, Logger } from '@cslug/core'
import type { Database } from './database'
import { sql } from './sql'

/** The framework's own migrations (idempotency table, …), always run before the app's. */
export const FRAMEWORK_MIGRATIONS = join(import.meta.dir, '../migrations')

const packageMigrations: string[] = []
/** A package's own migrations (`@cslug/auth`'s tokens table), run with the framework's, before the app's. */
export function addMigrations(dir: string): void {
  if (!packageMigrations.includes(dir)) packageMigrations.push(dir)
}

type MigrationFile = { name: string; path: string; up: string; down: string | undefined; transaction: boolean }
export type MigrationStatus = { name: string; ran: boolean; batch?: number; ranAt?: Date }

const NAME = /^\d{8}_\d{6}_[a-z0-9_]+\.sql$/

/** Split a file into its `-- up` and `-- down` sections. `-- cslug:no-transaction` runs it outside a transaction. */
export function parseMigration(path: string, text: string): MigrationFile {
  const name = basename(path, '.sql')
  const up = /^--\s*up\s*$/im.exec(text)
  const down = /^--\s*down\s*$/im.exec(text)
  if (!up) throw new CslugError('migration.invalid', `${name}: missing "-- up" section`)
  const upEnd = down && down.index > up.index ? down.index : text.length
  return {
    name,
    path,
    up: text.slice(up.index + up[0].length, upEnd).trim(),
    down: down
      ? text.slice(down.index + down[0].length, down.index > up.index ? text.length : up.index).trim()
      : undefined,
    transaction: !/^--\s*cslug:no-transaction\s*$/im.test(text),
  }
}

/**
 * Runs SQL-file migrations (`database/migrations/20261126_101500_create_bookings.sql`). Each migration runs in its
 * own transaction (unless marked `-- cslug:no-transaction`), is recorded in `cslug_migrations` with a batch
 * number, and the whole run holds an advisory lock, so concurrent runs (several instances starting) execute each
 * migration once.
 */
export class Migrator {
  readonly paths: string[]

  constructor(
    private readonly db: Database,
    options: { paths?: string[]; env?: string; log?: Logger } = {},
  ) {
    this.paths = [FRAMEWORK_MIGRATIONS, ...packageMigrations, ...(options.paths ?? [])]
    this.env = options.env ?? 'development'
    this.log = options.log ?? Logger.null()
  }

  private readonly env: string
  private readonly log: Logger

  /** Every migration file, ordered by name (timestamp). */
  files(): MigrationFile[] {
    const files: MigrationFile[] = []
    for (const dir of this.paths) {
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
        if (!NAME.test(file)) throw new CslugError('migration.invalid_name', `${file}: use YYYYMMDD_HHMMSS_name.sql`)
        const path = join(dir, file)
        files.push(parseMigration(path, readFileSync(path, 'utf8')))
      }
    }
    const names = new Set<string>()
    for (const f of files) {
      if (names.has(f.name)) throw new CslugError('migration.duplicate', `Two migrations are named ${f.name}`)
      names.add(f.name)
    }
    return files.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async ensureTable(): Promise<void> {
    await this.db.exec(sql`create table if not exists cslug_migrations (
      name text primary key, batch integer not null, ran_at timestamptz not null default now())`)
  }

  private async ran(): Promise<Map<string, { batch: number; ranAt: Date }>> {
    const rows = await this.db.many(
      sql<{ name: string; batch: number; ranAt: Date }>`select name, batch, ran_at from cslug_migrations`,
    )
    return new Map(rows.map((r) => [r.name, { batch: r.batch, ranAt: r.ranAt }]))
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.advisoryLock('cslug:migrations', async () => {
      await this.ensureTable()
      return fn()
    })
  }

  async status(): Promise<MigrationStatus[]> {
    await this.ensureTable()
    const ran = await this.ran()
    return this.files().map((f) => ({ name: f.name, ran: ran.has(f.name), ...ran.get(f.name) }))
  }

  /** Run pending migrations. Returns their names. */
  migrate(): Promise<string[]> {
    return this.locked(async () => {
      const ran = await this.ran()
      const pending = this.files().filter((f) => !ran.has(f.name))
      if (!pending.length) return []
      const batch = Math.max(0, ...[...ran.values()].map((r) => r.batch)) + 1
      for (const m of pending) {
        await this.apply(m, m.up, async (run) =>
          run(sql`insert into cslug_migrations (name, batch) values (${m.name}, ${batch})`),
        )
        this.log.info('migrated', { migration: m.name, batch })
      }
      return pending.map((m) => m.name)
    })
  }

  /** Undo the last `steps` batches (default 1), newest first. Returns the names rolled back. */
  rollback(options: { steps?: number } = {}): Promise<string[]> {
    return this.locked(async () => {
      const ran = await this.ran()
      const batches = [...new Set([...ran.values()].map((r) => r.batch))]
        .sort((a, b) => b - a)
        .slice(0, options.steps ?? 1)
      const files = new Map(this.files().map((f) => [f.name, f]))
      const targets = [...ran.entries()]
        .filter(([, r]) => batches.includes(r.batch))
        .map(([name]) => name)
        .sort()
        .reverse()
      for (const name of targets) {
        const m = files.get(name)
        if (!m) throw new CslugError('migration.missing_file', `${name} was run but its file is gone`)
        if (m.down === undefined || m.down === '')
          throw new CslugError('migration.no_down', `${name} has no "-- down" section`)
        await this.apply(m, m.down, async (run) => run(sql`delete from cslug_migrations where name = ${name}`))
        this.log.info('rolled back', { migration: name })
      }
      return targets
    })
  }

  /** Drop everything in the public schema and migrate from scratch. Refused in production. */
  async fresh(): Promise<string[]> {
    if (this.env === 'production')
      throw new CslugError('migration.fresh_in_production', 'migrate:fresh is refused when APP_ENV=production')
    await this.db.pool.unsafe('drop schema public cascade; create schema public;')
    return this.migrate()
  }

  private async apply(
    m: MigrationFile,
    script: string,
    record: (run: (q: ReturnType<typeof sql>) => Promise<unknown>) => Promise<unknown>,
  ) {
    try {
      if (m.transaction) {
        await this.db.transaction(async (tx) => {
          await tx.handle.unsafe(script)
          await record((q) => tx.exec(q))
        })
      } else {
        await this.db.pool.unsafe(script)
        await record((q) => this.db.exec(q))
      }
    } catch (error) {
      throw new CslugError('migration.failed', `Migration ${m.name} failed: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }

  /** Write a new, empty migration file (for `cslug make:migration name`). Returns its path. */
  static create(dir: string, name: string, now = new Date()): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${stamp}_${slug}.sql`)
    writeFileSync(path, '-- up\n\n\n-- down\n\n')
    return path
  }
}
