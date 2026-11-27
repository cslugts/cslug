/** The auth test app: users, a policy, a gate, login (password and magic link), tokens. */

import { AppError, Application, inject, Logger, resolve, ServiceProvider } from '@cslug/core'
import { DatabaseProvider, id, Repository, type Row, table, text, timestamps } from '@cslug/database'
import { type HttpContext, HttpKernel, HttpProvider, Router, redirect } from '@cslug/http'
import { csrf, session } from '@cslug/http/middleware'
import { v } from '@cslug/validation'
import { SQL } from 'bun'
import {
  AuthProvider,
  ability,
  auth,
  authenticate,
  can,
  Gate,
  guest,
  Hash,
  MagicLinks,
  Policy,
  Tokens,
  TwoFactor,
} from '../../src'

export const users = table('users', {
  id: id(),
  email: text(),
  name: text(),
  passwordHash: text().nullable(),
  role: text(),
  ...timestamps(),
})
type User = Row<typeof users>
export const bookings = table('bookings', { id: id(), travellerId: text(), status: text() })
type Booking = Row<typeof bookings>

declare module '@cslug/core' {
  interface AuthUser extends User {}
}

@inject()
export class UserRepository extends Repository(users) {}
@inject()
export class BookingRepository extends Repository(bookings) {}

@inject()
export class BookingPolicy extends Policy {
  before(user: User) {
    if (user.role === 'admin') return true
  }
  view(user: User, booking: Booking) {
    return booking.travellerId === user.id
  }
  pay(user: User, booking: Booking, amount: number) {
    return booking.travellerId === user.id && booking.status === 'proposed' && amount > 0
  }
}

class AppAuthProvider extends ServiceProvider {
  static dependsOn = [AuthProvider]
  boot() {
    this.app.resolve(Gate).define('admin.access', (user) => user.role === 'admin')
  }
}

const Login = v.object({ email: v.string(), password: v.string() })

export { TwoFactor }
export const routes = (r: Parameters<Router['load']>[0] extends (r: infer R) => void ? R : never) => {
  // what routes/web.ts and routes/api.ts get from HttpProvider + AuthProvider
  r.group({ middleware: [session(), csrf(), authenticate()] }, (r) => {
    r.get('/login', () => 'login page')
      .name('login')
      .middleware(guest())
    r.post('/login', async ({ request, auth }: HttpContext) => {
      const { email, password } = await request.validate(Login)
      if (!(await auth.attempt(email, password)))
        throw new AppError('auth.failed', 'These credentials do not match.', { status: 422 })
      if (auth.twoFactorPending) return redirect().to('/two-factor')
      return redirect().intended('/dashboard')
    })
    // the second step of a login with two-factor authentication
    r.post('/two-factor', async ({ request, auth }: HttpContext) => {
      const { code } = await request.validate(v.object({ code: v.string() }))
      if (!(await auth.completeTwoFactor(code)))
        throw new AppError('auth.two_factor_failed', 'This code is not valid.', { status: 422 })
      return redirect().intended('/dashboard')
    })
    // enrolment, for a signed-in user
    r.post('/settings/two-factor', async ({ auth }: HttpContext) =>
      resolve(TwoFactor).enable(auth.user(), auth.user().email),
    ).middleware(auth())
    r.post('/settings/two-factor/confirm', async ({ request, auth }: HttpContext) => {
      const { code } = await request.validate(v.object({ code: v.string() }))
      const recoveryCodes = await resolve(TwoFactor).confirm(auth.user(), code)
      if (!recoveryCodes) throw new AppError('auth.two_factor_failed', 'This code is not valid.', { status: 422 })
      return { recoveryCodes }
    }).middleware(auth())
    r.get('/dashboard', ({ auth }) => ({ hello: auth.user().name })).middleware(auth())
    r.get('/admin', () => 'admin').middleware(auth(), can('admin.access'))
    r.get('/bookings/:id', async ({ auth, params }) => {
      const booking = await resolve(BookingRepository).findOrFail(params.id)
      await auth.authorize(BookingPolicy, 'view', booking)
      return { booking: booking.id, canPay: await auth.can(BookingPolicy, 'pay', booking, 100) }
    }).middleware(auth())
    r.get('/magic/:token', async ({ params, auth }) => {
      const { user, redirectTo } = await resolve(MagicLinks).consume(params.token as string)
      await auth.login(user)
      return redirect().to(redirectTo)
    })
    r.post('/logout', async ({ auth }) => {
      await auth.logout()
      return redirect().to('/login')
    })
    r.get('/me', ({ user }) => ({ user: user?.email ?? null }))
  })
  r.group({ prefix: '/api', middleware: [authenticate()] }, (r) => {
    r.get('/quotes', ({ auth }) => ({ by: auth.user().email, guard: auth.guard })).middleware(
      auth('token'),
      ability('quotes:read'),
    )
    r.post('/quotes', () => ({ ok: true })).middleware(auth('token'), ability('quotes:write'))
  })
}

/** A throwaway database (from DATABASE_URL) and the app on it. */
export async function fixtureApp() {
  const url = process.env.DATABASE_URL as string
  const name = `cslug_auth_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).toString(), { max: 1 })
  await admin.unsafe(`create database "${name}"`)
  const app = new Application({
    root: import.meta.dir,
    configs: {
      app: { env: 'test', key: 'k'.repeat(32), url: 'https://albastr.test' },
      database: { url: Object.assign(new URL(url), { pathname: `/${name}` }).toString() },
      auth: { users: UserRepository, passwords: { memoryCost: 4096, timeCost: 1 }, throttle: '3/min' },
    },
  })
  app.useProviders([DatabaseProvider, AuthProvider, HttpProvider, AppAuthProvider])
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

export { Hash, Tokens }
