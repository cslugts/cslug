/** A small app for the test kit's own tests: http + database, a form, a JSON API, an event. */

import { Application, Event, inject, Logger } from '@cslug/core'
import { Database, DatabaseProvider, date, id, Repository, sql, table, text } from '@cslug/database'
import { type HttpContext, HttpProvider, Router, redirect } from '@cslug/http'
import { csrf, session } from '@cslug/http/middleware'
import { v } from '@cslug/validation'
import { SQL } from 'bun'

export const todos = table('todos', { id: id(), title: text(), dueOn: date().nullable() })
@inject()
export class TodoRepository extends Repository(todos) {}
export class TodoCreated extends Event<{ title: string }>('todo.created') {}

const StoreTodo = v.object({ title: v.string().trim().min(1), dueOn: v.date().future().optional() })

export const routes = (r: Parameters<Router['load']>[0] extends (r: infer R) => void ? R : never) => {
  r.group({ middleware: [session(), csrf()] }, (r) => {
    r.get('/todos/new', ({ session: s }: HttpContext) => `<form>${s.errors().title?.[0] ?? ''}</form>`)
    r.post('/todos', async ({ request, resolve }) => {
      const data = await request.validate(StoreTodo)
      const todo = await resolve(TodoRepository).create(data)
      await TodoCreated.emit({ title: todo.title })
      return redirect().to(`/todos/${todo.id}`).with('success', 'Todo added.')
    })
    r.get('/todos/:id', async ({ params, resolve }) => {
      const todo = await resolve(TodoRepository).findOrFail(params.id)
      return new Response(`<h1>${todo.title}</h1>`, { headers: { 'content-type': 'text/html' } })
    })
  })
  r.post('/api/todos', async ({ request, resolve }) =>
    resolve(TodoRepository).create(await request.validate(StoreTodo)),
  )
  r.get('/api/whoami', ({ request }) => ({ auth: request.header('authorization') ?? null }))
}

/** A throwaway database per test file (dropped in `drop()`), or none without DATABASE_URL. */
export async function fixtureApp() {
  const url = process.env.DATABASE_URL
  let dbUrl: string | undefined
  let drop = async () => {}
  if (url) {
    const name = `cslug_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
    const admin = new URL(url)
    admin.pathname = '/postgres'
    const conn = new SQL(admin.toString(), { max: 1 })
    await conn.unsafe(`create database "${name}"`)
    const u = new URL(url)
    u.pathname = `/${name}`
    dbUrl = u.toString()
    drop = async () => {
      await conn.unsafe(`drop database if exists "${name}" with (force)`)
      await conn.close()
    }
  }
  const app = new Application({
    root: import.meta.dir,
    configs: {
      app: { url: 'https://example.test', key: 'k'.repeat(32), env: 'test' },
      ...(dbUrl ? { database: { url: dbUrl } } : {}),
    },
  })
  app.useProviders(dbUrl ? [DatabaseProvider, HttpProvider] : [HttpProvider])
  app.singleton(Logger, () => Logger.null())
  return { app, drop }
}

/** Load the routes once the app has booted. */
export const withRoutes = (app: Application) => {
  app.resolve(Router).load(routes)
  return app
}
export { Database, sql }
