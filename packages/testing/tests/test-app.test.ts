import { afterAll, describe, expect, test } from 'bun:test'
import { Clock } from '@cslug/core'
import { HttpKernel } from '@cslug/http'
import { v } from '@cslug/validation'
import { testApp } from '../src'
import { Database, fixtureApp, sql, TodoCreated, TodoRepository, withRoutes } from './fixture/app'

const hasDb = !!process.env.DATABASE_URL
let drop = async () => {}
const t = testApp({
  async create() {
    const f = await fixtureApp()
    drop = f.drop
    // routes are loaded after start (HttpProvider loads route files; this fixture adds its own)
    const start = f.app.start.bind(f.app)
    f.app.start = async (...args) => {
      const started = await start(...args)
      withRoutes(started)
      started.resolve(HttpKernel).compile()
      return started
    }
    return f.app
  },
  fakes: ['events'],
})
afterAll(async () => {
  await drop()
})

describe.skipIf(!hasDb)('testApp: HTTP, sessions, database (real PostgreSQL)', () => {
  test('a form post: CSRF added automatically, redirect, flash, follow, the database', async () => {
    await t
      .post('/todos')
      .form({ title: 'Buy bread' })
      .assertRedirect()
      .assertSessionHas('success', 'Todo added.')
      .follow()
      .assertOk()
      .assertSee('<h1>Buy bread</h1>')
    await t.assertDatabaseHas('todos', { title: 'Buy bread' })
    expect(await t.db.count('todos')).toBe(1)
    t.events?.assertEmitted(TodoCreated, (e) => e.payload.title === 'Buy bread')
  })

  test('every test starts with an empty database (the previous test was rolled back)', async () => {
    expect(await t.db.count('todos')).toBe(0)
    await t.assertDatabaseMissing('todos', { title: 'Buy bread' })
  })

  test('a failed form: assertInvalid and assertOldInput read the flashed errors', async () => {
    await t
      .post('/todos')
      .form({ title: '  ' })
      .assertRedirect()
      .assertInvalid({ title: 'at least 1' })
      .assertOldInput({ title: '  ' })
    await t.get('/todos/new').assertSee('Must be at least 1 characters.') // same cookies: the next page shows it
  })

  test('JSON: assertJson, assertProblem, assertInvalid on 422', async () => {
    const res = await t.post('/api/todos').json({ title: 'API todo' }).assertOk().assertJson({ title: 'API todo' })
    expect(await t.db.find('todos', (await res.json()).id)).toMatchObject({ title: 'API todo' })
    await t
      .post('/api/todos')
      .json({ title: '' })
      .assertProblem(422, 'validation.failed')
      .assertInvalid({ title: 'at least 1' })
    await t
      .get('/todos/00000000-0000-7000-8000-000000000000')
      .header('accept', 'application/json')
      .assertProblem(404, 'todo.not_found')
  })

  test('headers, tokens, beforeRequest hooks', async () => {
    await t.get('/api/whoami').withToken('tok_1').assertJson({ auth: 'Bearer tok_1' })
    t.beforeRequest((r) => {
      r.header('authorization', 'Bearer from-hook')
    })
    await t.get('/api/whoami').assertJson({ auth: 'Bearer from-hook' })
  })

  test('the fake clock drives the app clock and v.date().future()', async () => {
    t.clock.travelTo('2027-05-14T12:00:00Z')
    expect(t.resolve(Clock).today()).toBe('2027-05-14')
    await t.post('/api/todos').json({ title: 'x', dueOn: '2027-05-14' }).assertProblem(422, 'validation.failed')
    await t.post('/api/todos').json({ title: 'x', dueOn: '2027-05-15' }).assertOk()
    t.clock.advance('2d')
    expect(v.date().future().safeParse('2027-05-15').success).toBe(false)
  })

  test('after-commit hooks under the test transaction fire when the savepoint is released', async () => {
    const db = t.resolve(Database)
    const ran: string[] = []
    await db.transaction(async (tx) => {
      tx.afterCommit(() => ran.push('committed'))
      await db.exec(sql`insert into todos (id, title) values (${Bun.randomUUIDv7()}, 'in tx')`)
    })
    expect(ran).toEqual(['committed'])
    expect(await t.db.count('todos', { title: 'in tx' })).toBe(1)
  })

  test('swaps and fakes are reset between tests', async () => {
    t.swap(TodoRepository, { create: async () => ({ id: 'fake', title: 'swapped' }) } as never)
    await t.post('/api/todos').json({ title: 'x' }).assertJson({ title: 'swapped' })
  })

  test('…and here the real repository is back', async () => {
    await t.post('/api/todos').json({ title: 'real' }).assertJson({ title: 'real' })
    expect(t.events?.of(TodoCreated)).toEqual([]) // the API route emits nothing; the fake was recreated
  })
})

describe('testApp without a database', () => {
  test('a helpful error when the app is used before it starts', () => {
    expect(typeof t.get).toBe('function')
  })
})
