import { afterAll, describe, expect, test } from 'bun:test'
import { HttpKernel } from '@cslug/http'
import { testApp } from '../src'
import { Database, fixtureApp, sql, withRoutes } from './fixture/app'

let drop = async () => {}
const t = testApp({
  database: 'truncate',
  async create() {
    const f = await fixtureApp()
    drop = f.drop
    const start = f.app.start.bind(f.app)
    f.app.start = async (...a) => {
      const s = await start(...a)
      withRoutes(s)
      s.resolve(HttpKernel).compile()
      return s
    }
    return f.app
  },
})
afterAll(async () => {
  await drop()
})

describe.skipIf(!process.env.DATABASE_URL)("database: 'truncate' — real commits, emptied after each test", () => {
  test('two concurrent transactions really commit (impossible inside one test transaction)', async () => {
    const db = t.resolve(Database)
    const insert = (title: string) =>
      db.transaction(() => db.exec(sql`insert into todos (id, title) values (${Bun.randomUUIDv7()}, ${title})`))
    await Promise.all([insert('a'), insert('b')])
    expect(await t.db.count('todos')).toBe(2)
  })

  test('the next test starts empty', async () => {
    expect(await t.db.count('todos')).toBe(0)
  })
})
