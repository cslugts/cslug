/**
 * @cslug/vue in the browser (the `browser` export condition; `cslug build` uses it). Same names as the server
 * entry, so components render on both sides; server-only APIs (`view`, `useRequest`, …) are absent or throw.
 */
import { formatIcu } from '@cslug/validation'
import { type App, createApp, createSSRApp } from 'vue'
import { formatDateIn, formatDurationIn, formatMoneyIn } from '../shared/format'
import { buildUrl } from '../shared/url'
import { pageData } from './data'

export { type Serialized, serialize } from '../serialize'
export {
  type ClientSchema,
  type Form,
  type FormCallbacks,
  type FormOptions,
  type SubmitOptions,
  useForm,
} from '../shared/form'
export { csrfHeaders, type HttpResult, http, type Progress, type RequestOptions } from '../shared/http'
export { defineStore } from '../shared/store'
export { type PageData, pageData } from './data'

/** Translations for islands: the namespaces they declared with `defineOptions({ lang: [...] })`. */
export function useT() {
  const data = pageData()
  const locale = data.locale
  return {
    locale,
    t: (key: string, params?: Record<string, unknown>) => {
      const message = data.messages[key]
      if (message === undefined) {
        console.warn(
          `[cslug] missing translation "${key}" in the browser: add its namespace to defineOptions({ lang: [...] })`,
        )
        return key
      }
      return formatIcu(message, params, locale)
    },
    tr: (value: Partial<Record<string, string>> | string | null | undefined) => {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      for (const l of data.chain) if (value[l]) return value[l] as string
      return Object.values(value).find(Boolean) ?? ''
    },
    formatMoney: (amount: Parameters<typeof formatMoneyIn>[1], currency?: string) =>
      formatMoneyIn(locale, amount, currency),
    formatDate: (value: Date | string, style?: Parameters<typeof formatDateIn>[2]) =>
      formatDateIn(locale, value, style),
  }
}

export const route = (name: string, params?: Record<string, unknown>, options?: Parameters<typeof buildUrl>[4]) =>
  buildUrl(pageData().routes, pageData().appUrl, name, params, options)
export const formatMoney = (amount: Parameters<typeof formatMoneyIn>[1], currency?: string) =>
  formatMoneyIn(pageData().locale, amount, currency)
export const formatDate = (value: Date | string, style?: Parameters<typeof formatDateIn>[2]) =>
  formatDateIn(pageData().locale, value, style)
export const formatDuration = (minutes: number) => formatDurationIn(pageData().locale, minutes)

/** Server only. */
export function useRequest(): never {
  throw new Error('useRequest() runs on the server only: pass what the island needs as props')
}

/** Longest wait for an idle period before a `hydrate="idle"` island hydrates anyway. */
const IDLE_TIMEOUT_MS = 2000

type MountOptions = { setup?: (app: App, island: { id: string; element: HTMLElement }) => void }

/**
 * Hydrate every `<cslug-island>` when its condition is met (load, idle, visible, media:…). Each island is its own
 * Vue app; `setup` installs app-wide plugins.
 */
export function mountIslands(options: MountOptions = {}): void {
  const data = pageData()
  for (const el of document.querySelectorAll<HTMLElement>('cslug-island:not([data-mounted])')) {
    const id = el.dataset.island as string
    const mode = el.dataset.hydrate ?? 'load'
    const mount = async () => {
      if (el.dataset.mounted) return
      el.dataset.mounted = 'pending'
      const url = data.islands[id]
      if (!url) throw new Error(`[cslug] no chunk for island ${id}: run cslug build`)
      const component = (await import(/* @vite-ignore */ url)).default
      const props = JSON.parse(el.dataset.props ?? '{}')
      const app = el.dataset.ssr === 'false' ? createApp(component, props) : createSSRApp(component, props)
      options.setup?.(app, { id, element: el })
      app.mount(el)
      el.dataset.mounted = 'true'
    }
    const run = () => {
      mount().catch((e) => console.error(e))
    }
    if (mode === 'load') run()
    else if (mode === 'idle') {
      // the timeout bounds the wait: a page that is never idle (busy main thread) still hydrates
      if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS })
      else setTimeout(run)
    } else if (mode === 'visible') {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect()
          run()
        }
      })
      observer.observe(el.firstElementChild ?? el)
    } else if (mode.startsWith('media:')) {
      const mq = matchMedia(mode.slice(6))
      if (mq.matches) run()
      else mq.addEventListener('change', run, { once: true })
    }
  }
  // development: let hot modules reuse this page's Vue (the condition is constant, so production drops the chunk)
  if (process.env.NODE_ENV !== 'production') import('./hmr').catch(() => {})
}
