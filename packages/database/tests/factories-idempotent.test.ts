import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Application, CslugError, inject, runInContext } from '@cslug/core'
import {
  Database,
  DatabaseProvider,
  Fake,
  factory,
  id,
  isSeeder,
  Migrator,
  Repository,
  seeder,
  sql,
  table,
  text,
  timestamp,
  uuid,
} from '../src'
import { describeDb, testDatabase } from './support'

const users = table('users', {
  id: id(),
  name: text(),
  email: text().unique(),
  passwordHash: text(),
  payoutAccount: text().encrypted().nullable(),
})
const todos = table('todos', {
  id: id(),
  userId: uuid().references(() => users),
  title: text(),
  priority: text().oneOf(['low', 'normal', 'high']).default('normal'),
  completedAt: timestamp().nullable(),
})

// the starter kit's factories, as written
const UserFactory = factory(users, ({ seq, fake }) => ({
  name: fake.name(),
  email: `user${seq}@example.test`,
  passwordHash: fake.passwordHash('password-password'),
}))
const TodoFactory = factory(todos, ({ seq, fake }) => ({
  userId: () => UserFactory.create().then((u) => u.id),
  title: `Todo ${seq}: ${fake.sentence(4)}`,
  priority: fake.pick(['low', 'normal', 'high'] as const),
})).state('done', ({ clock }) => ({ completedAt: clock.now() }))

@inject()
class UserRepository extends Repository(users) {}

let t: Awaited<ReturnType<typeof testDatabase>>
let app: Application
const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)

describe('Fake', () => {
  test('deterministic for a seed; plausible values', () => {
    const a = new Fake(7)
    const b = new Fake(7)
    expect([a.name(), a.email(), a.phone('MG')]).toEqual([b.name(), b.email(), b.phone('MG')])
    expect(new Fake().phone('MG')).toMatch(/^\+2613[2348]\d{7}$/)
    expect(new Fake().date('2027-05-01', '2027-05-03')).toMatch(/^2027-05-0[123]$/)
  })
  test('passwordHash verifies with Bun.password (cheap parameters, cached)', async () => {
    const hash = new Fake().passwordHash('password-password')
    expect(await Bun.password.verify('password-password', hash)).toBe(true)
    expect(new Fake().passwordHash('password-password')).toBe(hash)
  })
})

describeDb('factories, idempotent, encrypted columns (real PostgreSQL)', () => {
  beforeAll(async () => {
    t = await testDatabase()
    await new Migrator(t.db).migrate() // framework migrations (cslug_idempotency)
    await t.db.exec(
      sql`create table users (id uuid primary key, name text not null, email text not null unique, password_hash text not null, payout_account text)`,
    )
    await t.db.exec(sql`create table todos (id uuid primary key, user_id uuid not null references users(id), title text not null,
      priority text not null default 'normal', completed_at timestamptz)`)
    app = await new Application({ configs: { database: { url: t.url }, app: { key: 'k'.repeat(32) } } })
      .useProviders([DatabaseProvider])
      .start()
  })
  afterAll(async () => {
    await app?.shutdown()
    await t?.drop()
  })

  test('create with a lazy parent, states, for(), make', () =>
    inApp(async () => {
      const todo = await TodoFactory.create({ title: 'Buy bread' })
      expect(todo.title).toBe('Buy bread')
      expect(
        await app.resolve(Database).value<number>(sql`select count(*)::int from users where id = ${todo.userId}`),
      ).toBe(1)
      const me = await UserFactory.create({ name: 'Demo' })
      const mine = await TodoFactory.for({ userId: me.id }).state('done').createMany(3)
      expect(mine.every((x) => x.userId === me.id && x.completedAt instanceof Date)).toBe(true)
      const built = await TodoFactory.for({ userId: me.id }).make()
      expect(built.title).toMatch(/^Todo \d+: /)
      expect(() => TodoFactory.state('archived')).toThrow(/no state "archived" \(defined: done\)/)
    }))

  test('seeder()', async () => {
    const s = seeder(async () => {})
    expect(isSeeder(s)).toBe(true)
    expect(isSeeder({ run() {} })).toBe(false)
  })

  test('idempotent: the first result is replayed; concurrent calls run once', () =>
    inApp(async () => {
      const db = app.resolve(Database)
      let calls = 0
      const release = () =>
        db.idempotent('release:b1:1', async () => {
          calls++
          await Bun.sleep(20)
          return { transferId: `tr_${calls}`, amount: 30000n }
        })
      const results = await Promise.all([release(), release(), release()])
      expect(calls).toBe(1)
      // every call, the first included, gets the same JSON shape (Json<T>: bigint as string)
      for (const r of [...results, await release()]) expect(r).toEqual({ transferId: 'tr_1', amount: '30000' })
      const shape: { transferId: string; amount: string } = results[0]
      expect(shape.amount).toBe('30000')
    }))

  test('idempotent inside a rolled-back transaction records nothing', () =>
    inApp(async () => {
      const db = app.resolve(Database)
      let calls = 0
      await db
        .transaction(async () => {
          await db.idempotent('webhook:evt_1', async () => ++calls)
          throw new Error('rollback')
        })
        .catch(() => {})
      expect(await db.idempotent('webhook:evt_1', async () => ++calls)).toBe(2) // ran again: nothing was kept
    }))

  test('encrypted columns: ciphertext at rest, plaintext in the app, never searchable', () =>
    inApp(async () => {
      const repo = app.createScope().resolve(UserRepository)
      const u = await repo.create({ name: 'Op', email: 'op@x.test', passwordHash: 'x', payoutAccount: '+261341234567' })
      expect(u.payoutAccount).toBe('+261341234567')
      const raw = await app.resolve(Database).value<string>(sql`select payout_account from users where id = ${u.id}`)
      expect(raw).toMatch(/^v1\./)
      expect(raw).not.toContain('261341234567')
      expect((await repo.findOrFail(u.id)).payoutAccount).toBe('+261341234567')
      expect(() => repo.where({ payoutAccount: '+261341234567' })).toThrow(/is encrypted and cannot be used in a where/)
      expect(await repo.where({ email: 'op@x.test' }).count()).toBe(1)
    }))

  test('a wrong APP_KEY cannot decrypt (and says so)', async () => {
    const { decrypt, encrypt, setEncryptionKey } = await import('../src')
    const stored = encrypt('secret')
    setEncryptionKey('another-key-'.repeat(3))
    expect(() => decrypt(stored)).toThrow(CslugError)
    expect(() => decrypt(stored)).toThrow(/wrong APP_KEY/)
    setEncryptionKey('k'.repeat(32))
    expect(decrypt(stored)).toBe('secret')
  })
})
