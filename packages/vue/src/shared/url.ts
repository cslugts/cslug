/** A named route as sent to the browser. */
export type ClientRoute = { path: string; domain?: string }

const fill = (pattern: string, params: Record<string, unknown>, name: string, used: Set<string>) =>
  pattern.replace(/:([A-Za-z0-9_]+)/g, (_m, key: string) => {
    const value = params[key]
    if (value === undefined || value === null) throw new Error(`Route "${name}" needs parameter "${key}"`)
    used.add(key)
    return encodeURIComponent(String(value))
  })

/** Same rules as @cslug/http's `urlFor` (without signing, which needs the server key). */
export function buildUrl(
  routes: Record<string, ClientRoute>,
  appUrl: string | undefined,
  name: string,
  params: Record<string, unknown> = {},
  options: { absolute?: boolean; query?: Record<string, string | number | boolean | null | undefined> } = {},
): string {
  const route = routes[name]
  if (!route) throw new Error(`No route named "${name}" (is it named, and allowed by config vue.routes?)`)
  const used = new Set<string>()
  const path = fill(route.path, params, name, used)
  const host = route.domain ? fill(route.domain, params, name, used) : undefined
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(params))
    if (!used.has(k) && v !== undefined && v !== null) query.set(k, String(v))
  for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined && v !== null) query.set(k, String(v))
  const base = appUrl ? new URL(appUrl) : undefined
  const origin =
    options.absolute || (host && host !== base?.hostname)
      ? `${base?.protocol ?? 'https:'}//${host ?? base?.host ?? ''}`
      : ''
  return `${origin}${path}${query.size ? `?${query}` : ''}`
}
