import type { ClientRoute } from '../shared/url'

/** What `<Assets>` puts in the page for its islands (`<script type="application/json" id="cslug-data">`). */
export type PageData = {
  locale: string
  /** Locales tried for a message: the locale, its fallbacks, the default. */
  chain: string[]
  /** Messages of the namespaces the page's islands declared (`defineOptions({ lang: [...] })`), by key. */
  messages: Record<string, string>
  routes: Record<string, ClientRoute>
  appUrl?: string
  /** Island id → chunk URL. */
  islands: Record<string, string>
}

let cached: PageData | undefined
/** The data the server embedded in the page (`#cslug-data`): locale, messages, routes, islands. Read once. */
export function pageData(): PageData {
  if (cached) return cached
  const el = typeof document === 'undefined' ? null : document.getElementById('cslug-data')
  cached = el?.textContent
    ? (JSON.parse(el.textContent) as PageData)
    : { locale: 'en', chain: ['en'], messages: {}, routes: {}, islands: {} }
  return cached
}
