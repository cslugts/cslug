import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, type Command, ConsoleIO, Encrypter, Logger, runInContext } from '@cslug/core'
import { Database, DatabaseProvider, DbReencryptCommand, decrypt, needsReencrypt, sql } from '../src'
import { describeDb, testDatabase } from './support'

const OLD = 'old-key-old-key-old-key-old-key-0'
const NEW = 'new-key-new-key-new-key-new-key-1'

class Captured extends ConsoleIO {
  out = ''
  override write(text: string) {
    this.out += text
  }
}

describeDb('key rotation: encrypted columns', () => {
  let t: Awaited<ReturnType<typeof testDatabase>>
  const root = mkdtempSync(join(tmpdir(), 'cslug-reencrypt-'))
  mkdirSync(join(root, 'app/tables'), { recursive: true })
  writeFileSync(
    join(root, 'app/tables/payout-table.ts'),
    `import { id, table, text } from '${join(import.meta.dir, '../src')}'
export const payouts = table('payouts', { id: id(), iban: text().encrypted().nullable(), note: text() })
`,
  )
  beforeAll(async () => {
    t = await testDatabase()
    await t.db.exec(sql`create table payouts (id uuid primary key, iban text, note text not null)`)
  })
  afterAll(async () => {
    await t?.drop()
    rmSync(root, { recursive: true, force: true })
  })

  const app = async (key: string, previous?: string) => {
    const a = new Application({
      root,
      configs: { database: { url: t.url }, app: { env: 'test', key, previousKeys: previous } },
    })
    a.useProviders([DatabaseProvider]).singleton(Logger, () => Logger.null())
    await a.start()
    return a
  }

  test('old values read after a rotation; db:reencrypt moves them to the new key, once', async () => {
    const before = await app(OLD)
    const old = new Encrypter(OLD)
    const ids = Array.from({ length: 5 }, () => Bun.randomUUIDv7()).sort()
    for (const [i, id] of ids.entries())
      await t.db.exec(
        sql`insert into payouts values (${id}, ${i === 4 ? null : old.encrypt(`FR76 000${i}`)}, ${`note ${i}`})`,
      )
    await before.shutdown()

    const after = await app(NEW, OLD)
    const io = new Captured()
    after.instance(ConsoleIO, io)
    const run = () =>
      runInContext({ app: after, scope: after.createScope() }, () =>
        (
          new (DbReencryptCommand as unknown as new () => Command)() as unknown as { handle(a: unknown): unknown }
        ).handle({ batch: 2 }),
      )
    const stored = () =>
      after.resolve(Database).many<{ iban: string | null }>(sql`select iban from payouts order by id`)
    expect((await stored()).filter((r) => r.iban && needsReencrypt(r.iban))).toHaveLength(4)
    await run()
    expect(io.out).toContain('payouts: 4 rows re-encrypted')
    const rows = await stored()
    expect(rows.filter((r) => r.iban && needsReencrypt(r.iban))).toHaveLength(0)
    expect(rows.map((r) => (r.iban ? decrypt(r.iban) : null))).toEqual([
      'FR76 0000',
      'FR76 0001',
      'FR76 0002',
      'FR76 0003',
      null,
    ])
    expect(() => new Encrypter(OLD).decrypt(rows[0]?.iban as string)).toThrow()
    io.out = ''
    await run()
    expect(io.out).toContain('Nothing to re-encrypt')
    await after.shutdown()
  })
})
