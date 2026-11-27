/** Built-in middleware: `import { securityHeaders, bodyLimit, … } from '@cslug/http/middleware'`. */
import { CslugError, ForbiddenError, parseDuration } from '@cslug/core'
import type { MiddlewareFn } from '../router'
import { verifySignedUrl } from '../url'

import { csrf, session } from './web'

export { csrf, locale, type SessionOptions, session, throttle } from './web'

/** Security headers on every response (CSP is opt-in: it depends on your assets). */
export const securityHeaders =
  (options: { hsts?: boolean; csp?: string; frameOptions?: 'DENY' | 'SAMEORIGIN' } = {}): MiddlewareFn =>
  async (ctx, next) => {
    const res = await next()
    const h = res.headers
    const set = (k: string, v: string) => {
      if (!h.has(k)) h.set(k, v)
    }
    set('x-content-type-options', 'nosniff')
    set('x-frame-options', options.frameOptions ?? 'DENY')
    set('referrer-policy', 'strict-origin-when-cross-origin')
    set('cross-origin-opener-policy', 'same-origin')
    if (options.csp) set('content-security-policy', options.csp)
    if (options.hsts ?? ctx.app.config('app.env') === 'production')
      set('strict-transport-security', 'max-age=31536000; includeSubDomains')
    return res
  }

const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i
const bytes = (size: string | number) => {
  if (typeof size === 'number') return size
  const m = SIZE.exec(size.trim())
  if (!m) throw new CslugError('http.invalid_size', `Invalid size "${size}"`)
  return Math.round(
    Number(m[1]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] as string).toLowerCase() as 'b'],
  )
}

/** 413 when the declared body size is over the limit: `bodyLimit('1mb')`, `bodyLimit('20mb')` for uploads. */
export const bodyLimit =
  (limit: string | number): MiddlewareFn =>
  async (ctx, next) => {
    const max = bytes(limit)
    const declared = Number(ctx.request.header('content-length') ?? 0)
    if (declared > max) {
      throw Object.assign(new CslugError('http.payload_too_large', `The request body is larger than ${limit}.`), {
        status: 413,
      })
    }
    // also enforced on the bytes actually read (bodies without Content-Length, chunked uploads)
    ctx.request.maxBodyBytes = Math.min(ctx.request.maxBodyBytes ?? Number.POSITIVE_INFINITY, max)
    return next()
  }

/** Abort the handler's work after a duration (`ctx.signal` fires) and answer 503. */
export const timeout =
  (duration: string | number): MiddlewareFn =>
  async (ctx, next) => {
    const controller = new AbortController()
    const onAbort = () => controller.abort(ctx.signal.reason)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    Object.assign(ctx, { signal: controller.signal })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort(new Error('timeout'))
            reject(Object.assign(new CslugError('http.timeout', 'The request took too long.'), { status: 503 }))
          }, parseDuration(duration))
        }),
      ])
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener?.('abort', onAbort)
    }
  }

/** 403 unless the URL was made by `route(name, params, { signed: true })` and has not expired. */
export const signed = (): MiddlewareFn => async (ctx, next) => {
  const key = ctx.app.config<string | undefined>('app.key')
  if (!key || !verifySignedUrl(ctx.request.url.toString(), key))
    throw new ForbiddenError('http.invalid_signature', 'This link is invalid or has expired.')
  return next()
}

/**
 * Is this request from the app's own pages? Its `Origin` (or, without one, its `Referer`) is one of `origins`, or the
 * browser says `Sec-Fetch-Site: same-origin`.
 */
export function fromFrontEnd(headers: { header(name: string): string | undefined }, origins: string[]): boolean {
  const originOf = (url: string | undefined) => {
    try {
      return url ? new URL(url).origin : undefined
    } catch {
      return undefined
    }
  }
  const origin = headers.header('origin') ?? originOf(headers.header('referer'))
  if (origin) return origins.includes(origin)
  return headers.header('sec-fetch-site') === 'same-origin'
}

/**
 * The session for API routes called by the app's own pages (`http.api.stateful`, what Laravel Sanctum calls an SPA):
 * a request from one of `origins` (default: `app.url`'s) gets `session()` and `csrf()`, so `useForm` / `http` in an
 * island reach `routes/api.ts` with the signed-in user. Other clients are left to API tokens. Runs before
 * `authenticate()`.
 */
export const statefulApi = (origins?: string[]): MiddlewareFn => {
  const withSession = session()
  const withCsrf = csrf()
  return (ctx, next) => {
    const allowed = origins ?? [new URL(ctx.app.config<string>('app.url') ?? 'http://localhost').origin]
    if (!fromFrontEnd(ctx.request, allowed)) return next()
    return withSession(ctx, () => Promise.resolve(withCsrf(ctx, next)))
  }
}

/** CORS for API routes. `origins: ['*']` allows any origin (without credentials). */
export const cors =
  (options: {
    origins: string[]
    methods?: string[]
    headers?: string[]
    credentials?: boolean
    maxAge?: number
  }): MiddlewareFn =>
  async (ctx, next) => {
    const origin = ctx.request.header('origin')
    const allowed = origin && (options.origins.includes('*') || options.origins.includes(origin)) ? origin : undefined
    const apply = (h: Headers) => {
      if (!allowed) return
      h.set('access-control-allow-origin', options.origins.includes('*') && !options.credentials ? '*' : allowed)
      if (options.credentials) h.set('access-control-allow-credentials', 'true')
      h.append('vary', 'Origin')
    }
    if (ctx.request.method === 'OPTIONS' && ctx.request.header('access-control-request-method')) {
      const res = new Response(null, { status: 204 })
      apply(res.headers)
      res.headers.set(
        'access-control-allow-methods',
        (options.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).join(', '),
      )
      res.headers.set(
        'access-control-allow-headers',
        (options.headers ?? ['content-type', 'authorization', 'x-csrf-token']).join(', '),
      )
      res.headers.set('access-control-max-age', String(options.maxAge ?? 600))
      return res
    }
    const res = await next()
    apply(res.headers)
    return res
  }
