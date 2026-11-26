import { ForbiddenError, UnauthorizedError } from '@cslug/core'
import { type HttpContext, type MiddlewareFn, Router, redirect, route } from '@cslug/http'
import { Auth, type AuthDeps } from './auth'
import type { AuthConfig } from './config'

/** Deps for `Auth`, registered by `AuthProvider`. */
export const AUTH_DEPS = Symbol.for('cslug.auth.deps')

async function ensureAuth(ctx: HttpContext): Promise<Auth> {
  const existing = (ctx as { auth?: Auth }).auth
  if (existing?.loaded) return existing
  const deps = (ctx.app as unknown as Record<symbol, AuthDeps | undefined>)[AUTH_DEPS]
  if (!deps) throw new Error('Auth middleware needs AuthProvider in bootstrap/providers.ts')
  const auth = new Auth(ctx, deps)
  ;(ctx as { auth?: Auth }).auth = auth
  await auth.load()
  return auth
}

/** Load the user (session or Bearer token) into `ctx.auth` / `ctx.user`. In the web and api groups. */
export const authenticate = (): MiddlewareFn => async (ctx, next) => {
  await ensureAuth(ctx)
  return next()
}

/**
 * Require a signed-in user (optionally through one guard: `auth('token')`). Guests get 401 (JSON), or are sent
 * to the login page with the URL remembered for `redirect().intended()` (HTML).
 */
export const auth =
  (guard?: 'web' | 'token'): MiddlewareFn =>
  async (ctx, next) => {
    const a = await ensureAuth(ctx)
    if (a.check() && (!guard || a.guard === guard)) return next()
    if (ctx.request.wantsJson() || guard === 'token' || ctx.session.constructor.name === 'MissingSession')
      throw new UnauthorizedError()
    if (ctx.request.method === 'GET') {
      const url = new URL(ctx.request.url)
      ctx.session.put('url.intended', url.pathname + url.search)
    }
    return redirect().to(loginUrl(ctx)).toResponse(ctx)
  }

/** Only for guests (login and register pages): signed-in users go to `config('auth.home')`. */
export const guest = (): MiddlewareFn => async (ctx, next) => {
  const a = await ensureAuth(ctx)
  if (!a.check()) return next()
  return redirect()
    .to(ctx.app.config<string | undefined>('auth.home') ?? '/')
    .toResponse(ctx)
}

/** API token abilities: `ability('quotes:write')`. Session users pass; tokens need every listed ability. */
export const ability =
  (...abilities: string[]): MiddlewareFn =>
  async (ctx, next) => {
    const a = await ensureAuth(ctx)
    if (!a.check()) throw new UnauthorizedError()
    if (!abilities.every((x) => a.tokenCan(x)))
      throw new ForbiddenError('auth.token_ability', `This token lacks the ability: ${abilities.join(', ')}`)
    return next()
  }

/** A gate as middleware: `can('admin.access')`. */
export const can =
  (gate: string): MiddlewareFn =>
  async (ctx, next) => {
    await (await ensureAuth(ctx)).authorize(gate)
    return next()
  }

function loginUrl(ctx: HttpContext): string {
  const target = ctx.app.config<AuthConfig['loginRoute']>('auth.loginRoute') ?? 'login'
  if (target.startsWith('/')) return target
  return ctx.resolve(Router).byName(target) ? route(target) : '/login'
}
