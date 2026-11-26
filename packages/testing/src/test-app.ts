import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'bun:test'
import { join } from 'node:path'
import {
  type Application,
  Cache,
  Clock,
  FakeClock,
  Lock,
  MemoryCache,
  MemoryLock,
  MemoryRateLimiter,
  MemorySessionStore,
  RateLimiter,
  type Resolved,
  SessionStore,
  type Token,
} from '@cslug/core'
import { fakeInstaller, type TestFakes } from './fakes'
import { CookieJar, type Handler, PendingRequest, testSession } from './request'

type Db = {
  value(q: unknown): Promise<unknown>
  maybeOne(q: unknown): Promise<Record<string, unknown> | null>
  exec(q: unknown): Promise<number>
  pin(): Promise<{ release(): Promise<void> }>
  pool: { unsafe(text: string): Promise<unknown> }
}
type DatabaseModule = typeof import('@cslug/database')

export type TestAppOptions = {
  /** Build the app; default: `createApp()` from `<cwd>/bootstrap/app.ts`. */
  create?: () => Application | Promise<Application>
  /** Config overrides, by dotted path: `{ 'payments.driver': 'fake' }`. */
  config?: Record<string, unknown>
  /** Fakes to install for every test: `'events'`, and those packages add (`'queue'`, `'mail'`, …). */
  fakes?: (keyof TestFakes | string)[]
  /**
   * Database isolation per test. `'transaction'` (default): every test runs in a transaction that is rolled
   * back. `'truncate'`: real commits, tables truncated after each test (for concurrency, locks, after-commit
   * across connections). `false`: nothing.
   */
  database?: 'transaction' | 'truncate' | false
  /** Run migrations once before the tests (default true when a database is configured). */
  migrate?: boolean
  /** Host used for requests (default: the host of `app.url`, else `localhost`). */
  host?: string
}

/** What `testApp()` returns: the app, an HTTP client without a port, database helpers, the clock, fakes. */
export type TestApp = {
  readonly app: Application
  readonly clock: FakeClock
  readonly fakes: Partial<TestFakes>
  resolve<K extends Token>(token: K): Resolved<K>
  swap<T>(token: Token<T>, value: T): void
  get(path: string): PendingRequest
  post(path: string): PendingRequest
  put(path: string): PendingRequest
  patch(path: string): PendingRequest
  delete(path: string): PendingRequest
  /** Run something before each request of this test (the auth package uses it for `actingAs`). */
  beforeRequest(hook: (r: PendingRequest) => void | Promise<void>): void
  /** Requests of this test run as `user` (signed in through the session, like `auth.login`). Needs @cslug/auth. */
  actingAs(user: { id: unknown }): void
  readonly db: {
    /** `count('ledger_entries', { bookingId })`: camelCase keys, snake_case columns. */
    count(table: string, where?: Record<string, unknown>): Promise<number>
    find(table: string, id: unknown): Promise<Record<string, unknown> | null>
  }
  assertDatabaseHas(table: string, where: Record<string, unknown>): Promise<void>
  assertDatabaseMissing(table: string, where: Record<string, unknown>): Promise<void>
} & Partial<TestFakes>

/**
 * Set up an app for a test file: built and started once, isolated per test (database, cookies, fakes, clock,
 * swaps). Call it at the top of the file:
 *
 * ```ts
 * const t = testApp({ fakes: ['events'] })
 * test('…', async () => { await t.get('/todos').assertOk() })
 * ```
 */
export function testApp(options: TestAppOptions = {}): TestApp {
  let app: Application | undefined
  let db: Db | undefined
  let dbModule: DatabaseModule | undefined
  let pin: { release(): Promise<void> } | undefined
  let clock = new FakeClock()
  const jar = new CookieJar()
  const hooks: ((r: PendingRequest) => void | Promise<void>)[] = []
  const fakes: Record<string, unknown> = {}
  let handle: Handler | undefined

  const need = (): Application => {
    if (!app)
      throw new Error('testApp(): the app is not started yet (use it inside test(), beforeEach() or afterEach())')
    return app
  }

  beforeAll(async () => {
    app = options.create ? await options.create() : await defaultApp()
    for (const [path, value] of Object.entries(options.config ?? {})) app.setConfig(path, value)
    await app.start()
    try {
      dbModule = await import('@cslug/database')
      if (app.has(dbModule.Database) && app.config('database.url')) db = app.resolve(dbModule.Database) as unknown as Db
    } catch {
      // @cslug/database not installed
    }
    if (db && dbModule && options.migrate !== false) {
      await new dbModule.Migrator(db as never, {
        paths: [join(app.rootDir, 'database/migrations')],
        env: 'test',
      }).migrate()
    }
    try {
      const http = await import('@cslug/http')
      if (app.has(http.HttpKernel)) {
        const kernel = app.resolve(http.HttpKernel)
        handle = (req) => kernel.handle(req, { ip: '127.0.0.1' })
      }
    } catch {
      // @cslug/http not installed
    }
  })

  beforeEach(async () => {
    const a = need()
    jar.clear()
    hooks.length = 0
    clock = new FakeClock(a.config<string | undefined>('app.timezone') ?? 'UTC')
    a.swap(Clock, clock)
    // in-memory stores start empty in every test (rate limits, locks, cache, sessions); Redis ones are left alone
    for (const [contract, Memory] of MEMORY_DRIVERS)
      if (a.resolve(contract as Token<unknown>) instanceof Memory) a.swap(contract as Token<unknown>, new Memory())
    for (const name of options.fakes ?? []) {
      const install = fakeInstaller(String(name))
      if (!install) throw new Error(`testApp(): no fake named "${String(name)}" (is its package installed?)`)
      fakes[String(name)] = install(a)
    }
    if (db && (options.database ?? 'transaction') === 'transaction') pin = await db.pin()
  })

  afterEach(async () => {
    await pin?.release()
    pin = undefined
    if (db && options.database === 'truncate') {
      await db.pool.unsafe(`do $$ declare r record; begin
        for r in select tablename from pg_tables where schemaname = 'public' and tablename <> 'cslug_migrations' loop
          execute 'truncate table ' || quote_ident(r.tablename) || ' restart identity cascade';
        end loop; end $$;`)
    }
    app?.restoreSwaps()
    for (const k of Object.keys(fakes)) delete fakes[k]
  })

  afterAll(async () => {
    await app?.shutdown()
  })

  const request = (method: string) => (path: string) => {
    const a = need()
    if (!handle) throw new Error('testApp(): HTTP requests need @cslug/http and HttpProvider')
    const host = options.host ?? hostOf(a.config<string | undefined>('app.url'))
    return new PendingRequest(method, path, { app: a, jar, handle, host, before: hooks })
  }

  const whereSql = (sqlTag: DatabaseModule['sql'], where: Record<string, unknown>) => {
    const parts = Object.entries(where).map(([k, v]) => {
      const column = sqlTag.ident(k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
      return v === null ? sqlTag`${column} is null` : sqlTag`${column} = ${v}`
    })
    return parts.length ? sqlTag` where ${sqlTag.join(parts, sqlTag` and `)}` : sqlTag``
  }
  const dbOrFail = () => {
    if (!db || !dbModule) throw new Error('testApp(): no database configured (config database.url)')
    return { db, sql: dbModule.sql }
  }

  const api = {
    get app() {
      return need()
    },
    get clock() {
      return clock
    },
    fakes: fakes as Partial<TestFakes>,
    resolve: <K extends Token>(token: K) => need().resolve(token) as Resolved<K>,
    swap: <T>(token: Token<T>, value: T) => {
      need().swap(token, value)
    },
    get: request('GET'),
    post: request('POST'),
    put: request('PUT'),
    patch: request('PATCH'),
    delete: request('DELETE'),
    actingAs: (user: { id: unknown }) => {
      hooks.push(async () => {
        const session = await testSession(need(), jar)
        await session.write({ 'auth.id': String(user.id) }) // @cslug/auth's SESSION_KEY
      })
    },
    beforeRequest: (hook: (r: PendingRequest) => void | Promise<void>) => {
      hooks.push(hook)
    },
    db: {
      async count(table: string, where: Record<string, unknown> = {}) {
        const { db, sql } = dbOrFail()
        return Number(await db.value(sql`select count(*)::int from ${sql.ident(table)}${whereSql(sql, where)}`))
      },
      async find(table: string, id: unknown) {
        const { db, sql } = dbOrFail()
        return db.maybeOne(sql`select * from ${sql.ident(table)} where id = ${id}`)
      },
    },
    async assertDatabaseHas(table: string, where: Record<string, unknown>) {
      expect(
        await api.db.count(table, where),
        `no row in ${table} matching ${JSON.stringify(where, bigintSafe)}`,
      ).toBeGreaterThan(0)
    },
    async assertDatabaseMissing(table: string, where: Record<string, unknown>) {
      expect(await api.db.count(table, where), `a row in ${table} matches ${JSON.stringify(where, bigintSafe)}`).toBe(0)
    },
  }
  return new Proxy(api, {
    get(target, key, receiver) {
      if (typeof key === 'string' && key in fakes) return fakes[key]
      return Reflect.get(target, key, receiver)
    },
  }) as unknown as TestApp
}

const MEMORY_DRIVERS = [
  [Cache, MemoryCache],
  [Lock, MemoryLock],
  [RateLimiter, MemoryRateLimiter],
  [SessionStore, MemorySessionStore],
] as const

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)
const hostOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).host : 'localhost'
  } catch {
    return 'localhost'
  }
}

async function defaultApp(): Promise<Application> {
  const path = join(process.cwd(), 'bootstrap/app.ts')
  const mod = (await import(path)) as { createApp?: () => Application }
  if (typeof mod.createApp !== 'function')
    throw new Error(`testApp(): ${path} must export createApp(), or pass testApp({ create })`)
  return mod.createApp()
}
