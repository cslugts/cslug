import { CslugError, currentApp, Encrypter, parseDuration } from '@cslug/core'
import { Router } from './router'

export type UrlOptions = {
  absolute?: boolean
  query?: Record<string, string | number | boolean | null | undefined>
  /** Add an HMAC signature (APP_KEY); verify with the `signed()` middleware. */
  signed?: boolean
  expiresIn?: string | number
}

const fill = (pattern: string, params: Record<string, unknown>, name: string, used: Set<string>) =>
  pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
    const value = params[key]
    if (value === undefined || value === null)
      throw new CslugError('http.missing_route_param', `Route "${name}" needs parameter "${key}"`)
    used.add(key)
    return encodeURIComponent(String(value))
  })

/** The app's `Encrypter` (current and previous keys), or one for a plain key. */
const signer = (key: string | Encrypter | undefined): Encrypter | undefined =>
  typeof key === 'string' ? (key ? new Encrypter(key) : undefined) : key?.configured ? key : undefined

/** Build a URL from a route name. Without `absolute`, a path is returned unless the route is on another domain. */
export function urlFor(
  router: Router,
  appUrl: string | undefined,
  /** `APP_KEY`, or the app's `Encrypter` (signed with `APP_KEY`, verified with previous keys too). */
  key: string | Encrypter | undefined,
  name: string,
  params: Record<string, unknown> = {},
  options: UrlOptions = {},
): string {
  const route = router.byName(name)
  if (!route) throw new CslugError('http.unknown_route', `No route named "${name}"`)
  const used = new Set<string>()
  const path = fill(route.path, params, name, used)
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(params))
    if (!used.has(k) && v !== undefined && v !== null && !route.domain?.includes(`:${k}`)) query.set(k, String(v))
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== null) query.set(k, String(v))

  const base = appUrl ? new URL(appUrl) : undefined
  const host = route.domain ? fill(route.domain, params, name, used) : undefined
  const absolute = options.absolute || options.signed || (host !== undefined && host !== base?.hostname)
  let origin = ''
  if (absolute) {
    if (!base) throw new CslugError('http.no_app_url', 'Absolute URLs need config app.url')
    origin = `${base.protocol}//${host ?? base.host}${host && base.port ? `:${base.port}` : ''}`
  }
  if (options.signed) {
    const keys = signer(key)
    if (!keys) throw new CslugError('http.no_app_key', 'Signed URLs need APP_KEY (config app.key)')
    if (options.expiresIn !== undefined)
      query.set('expires', String(Math.floor((Date.now() + parseDuration(options.expiresIn)) / 1000)))
    query.sort()
    const unsigned = `${origin}${path}${query.size ? `?${query}` : ''}`
    query.set('signature', keys.sign(unsigned))
  }
  return `${origin}${path}${query.size ? `?${query}` : ''}`
}

/** Is a request URL correctly signed (with `APP_KEY` or a previous key) and not expired? */
export function verifySignedUrl(url: string, key: string | Encrypter | undefined, now = Date.now()): boolean {
  const keys = signer(key)
  if (!keys) return false
  const u = new URL(url)
  const given = u.searchParams.get('signature')
  if (!given) return false
  u.searchParams.delete('signature')
  u.searchParams.sort()
  if (!keys.verify(`${u.origin}${u.pathname}${u.searchParams.size ? `?${u.searchParams}` : ''}`, given)) return false
  const expires = u.searchParams.get('expires')
  return !expires || Number(expires) * 1000 > now
}

/** `route('bookings.show', { booking: id })` from the current app. */
export function route(name: string, params: Record<string, unknown> = {}, options: UrlOptions = {}): string {
  const app = currentApp()
  return urlFor(
    app.resolve(Router),
    app.config<string | undefined>('app.url'),
    app.resolve(Encrypter),
    name,
    params,
    options,
  )
}
