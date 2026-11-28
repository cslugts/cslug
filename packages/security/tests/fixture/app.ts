/** The security test app: users who log in with a password, tokens, and a route that audits a change. */

import { AppError, Application, inject, Logger, resolve } from '@cslug/core'
import { Database, DatabaseProvider, id, Repository, table, text, timestamps } from '@cslug/database'
import { type HttpContext, HttpKernel, HttpProvider, Router, redirect } from '@cslug/http'
import { session } from '@cslug/http/middleware'
import { v } from '@cslug/validation'
import { SQL } from 'bun'
// relative, not '@cslug/auth': through the package link TypeScript would see a second copy of auth's HttpContext
// augmentation when the workspace is reachable through two paths
import { AuthProvider, authenticate, Hash, Tokens } from '../../../auth/src'
import { Audit, SecurityProvider } from '../../src'

export const users = table('users', {
  id: id(),
  email: text(),
  name: text(),
  passwordHash: text().nullable(),
  role: text(),
  ...timestamps(),
})

@inject()
export class UserRepository extends Repository(users) {}

const Login = v.object({ email: v.string(), password: v.string() })

const routes = (r: Parameters<Router['load']>[0] extends (r: infer R) => void ? R : never) => {
  r.group({ middleware: [session(), authenticate()] }, (r) => {
    r.post('/login', async ({ request, auth }: HttpContext) => {
      const { email, password } = await request.validate(Login)
      if (!(await auth.attempt(email, password)))
        throw new AppError('auth.failed', 'These credentials do not match.', { status: 422 })
      return redirect().to('/dashboard')
    })
    r.post('/logout', async ({ auth }) => {
      await auth.logout()
      return redirect().to('/login')
    })
    r.post('/tokens', async ({ auth }) => {
      const { token } = await resolve(Tokens).create(auth.user(), { name: 'cli', abilities: ['quotes:read'] })
      return { id: token.id }
    })
    // a change and its audit entry in one transaction; ?fail rolls both back
    r.post('/bookings/:id/refund', async ({ params, request }) => {
      await resolve(Database).transaction(async () => {
        await resolve(Audit).record('booking.refunded', {
          subject: { type: 'booking', id: params.id as string },
          data: { amount: 12_000n, cardNumber: '4242' },
        })
        if (request.url.searchParams.has('fail')) throw new AppError('booking.refund_failed', 'No.', { status: 409 })
      })
      return { ok: true }
    })
  })
}

/** A throwaway database (from DATABASE_URL) and the app on it. */
export async function fixtureApp(security: Record<string, unknown>) {
  const url = process.env.DATABASE_URL as string
  const name = `cslug_security_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).toString(), { max: 1 })
  await admin.unsafe(`create database "${name}"`)
  const app = new Application({
    root: import.meta.dir,
    configs: {
      app: { env: 'test', key: 'k'.repeat(32), url: 'https://example.test' },
      database: { url: Object.assign(new URL(url), { pathname: `/${name}` }).toString() },
      auth: { users: UserRepository, passwords: { memoryCost: 4096, timeCost: 1 }, throttle: '100/min' },
      security,
    },
  })
  app.useProviders([DatabaseProvider, AuthProvider, HttpProvider, SecurityProvider])
  app.singleton(Logger, () => Logger.null())
  const start = app.start.bind(app)
  app.start = async (...a) => {
    const s = await start(...a)
    s.resolve(Router).load(routes, { middleware: [] })
    s.resolve(HttpKernel).compile()
    return s
  }
  return {
    app,
    drop: async () => {
      await admin.unsafe(`drop database if exists "${name}" with (force)`)
      await admin.close()
    },
  }
}

export const makeUser = async (email = 'ada@example.test', password = 'correct horse') =>
  resolve(UserRepository).create({
    email,
    name: 'Ada',
    role: 'traveller',
    passwordHash: await resolve(Hash).make(password),
  })
