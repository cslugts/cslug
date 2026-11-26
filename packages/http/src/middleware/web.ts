import {
  CslugError,
  currentContext,
  parseDuration,
  RateLimiter,
  SessionStore,
  TooManyRequestsError,
  Translator,
} from '@cslug/core'
import type { HttpContext } from '../context'
import { ExceptionHandler } from '../errors'
import type { MiddlewareFn } from '../router'
import { Session } from '../session'

export type SessionOptions = {
  cookie?: string
  lifetime?: string
  sameSite?: 'lax' | 'strict' | 'none'
  /** Cookie domain, e.g. `.albastr.com` to share a login across subdomains. */
  domain?: string
}

/**
 * Load the session from its cookie (or start one), run the request, save what changed, send the cookie.
 * Config: `session` (`cookie`, `lifetime`, `sameSite`, `domain`); data lives in the bound `SessionStore`.
 */
export const session =
  (options: SessionOptions = {}): MiddlewareFn =>
  async (ctx, next) => {
    const config = { ...ctx.app.config<SessionOptions | undefined>('session'), ...options }
    const name = config.cookie ?? 'cslug_session'
    const lifetime = config.lifetime ?? '14d'
    const store = ctx.resolve(SessionStore)
    const id = ctx.request.cookie(name)
    const data = id ? await store.read(id) : undefined
    const s = id && data ? new Session(id, data, false) : Session.create()
    ctx.session = s

    let res: Response
    try {
      res = await next()
    } catch (error) {
      // render here, inside the session, so what the handler flashes (form errors, old input) is saved
      res = await ctx.resolve(ExceptionHandler).handle(error, ctx)
    }
    await s.save(store, lifetime)
    if (s.needsCookie || s.id !== id) {
      const seconds = Math.floor(parseDuration(lifetime) / 1000)
      res = withCookie(res, ctx, name, s.id, seconds, config)
    }
    return res
  }

function withCookie(
  res: Response,
  ctx: HttpContext,
  name: string,
  value: string,
  maxAge: number,
  config: SessionOptions,
): Response {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${capitalize(config.sameSite ?? 'lax')}`,
    `Max-Age=${maxAge}`,
  ]
  if (ctx.app.config('app.env') === 'production' || config.sameSite === 'none') parts.push('Secure')
  if (config.domain) parts.push(`Domain=${config.domain}`)
  const headers = new Headers(res.headers)
  headers.append('set-cookie', parts.join('; '))
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** 419 for state-changing requests without the session's CSRF token (`_token` field or `X-CSRF-Token` header). */
export const csrf =
  (options: { except?: (string | RegExp)[] } = {}): MiddlewareFn =>
  async (ctx, next) => {
    const safe = ['GET', 'HEAD', 'OPTIONS'].includes(ctx.request.method)
    const excepted = options.except?.some((p) =>
      typeof p === 'string' ? ctx.request.path === p : p.test(ctx.request.path),
    )
    ctx.session.token() // make sure a token exists for the forms of this page
    if (!safe && !excepted) {
      const body = ctx.request.isForm ? await ctx.request.body() : {}
      const given = ctx.request.header('x-csrf-token') ?? (typeof body._token === 'string' ? body._token : undefined)
      if (!ctx.session.verifyToken(given)) {
        throw Object.assign(new CslugError('http.csrf_mismatch', 'The page expired. Reload it and try again.'), {
          status: 419,
        })
      }
    }
    return next()
  }

/**
 * Rate limit a route: `throttle('5/min')`, keyed by the user (when known) or the IP; or pass a key function.
 * Adds `X-RateLimit-Limit/Remaining`; over the limit → 429 with `Retry-After`.
 */
export const throttle =
  (limit: string, key?: (ctx: HttpContext) => string | Promise<string>): MiddlewareFn =>
  async (ctx, next) => {
    const limiter = ctx.resolve(RateLimiter)
    const who = key
      ? await key(ctx)
      : `${(currentContext()?.userId as string | undefined) ?? ctx.request.ip() ?? 'unknown'}`
    const result = await limiter.hit(`throttle:${ctx.routeName ?? ctx.request.path}:${who}`, limit)
    if (!result.allowed) throw new TooManyRequestsError(result.retryAfter)
    const res = await next()
    res.headers.set('x-ratelimit-limit', limit.split('/')[0] ?? limit)
    res.headers.set('x-ratelimit-remaining', String(result.remaining))
    return res
  }

/**
 * Pick the request's locale: the `:locale` route parameter, then the `locale` cookie, then `Accept-Language`,
 * then the default. Only locales listed in `config('i18n.locales')` are accepted. Sets `ctx.locale` and the
 * ambient locale used by `t()`.
 */
export const locale = (): MiddlewareFn => async (ctx, next) => {
  const translator = ctx.resolve(Translator)
  const supported = translator.locales
  const pick = (l: string | undefined) => (l && supported.includes(l) ? l : undefined)
  const fromHeader = (ctx.request.header('accept-language') ?? '')
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=')
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q) : 1 }
    })
    .sort((a, b) => b.q - a.q)
    .map(({ tag }) => pick(tag) ?? pick(tag.split('-')[0]))
    .find(Boolean)
  const chosen = pick(ctx.params.locale) ?? pick(ctx.request.cookie('locale')) ?? fromHeader ?? translator.defaultLocale
  ctx.locale = chosen
  const store = currentContext()
  if (store) store.locale = chosen
  return next()
}
