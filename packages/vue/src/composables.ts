/**
 * Composables for views and components. These are the server versions; the browser build (M4b) resolves
 * `@cslug/vue` to versions with the same names and signatures.
 */
import { currentApp, currentLocale, formatDate, formatMoney, Translator, t, tr } from '@cslug/core'
import { route as httpRoute, Router, type UrlOptions } from '@cslug/http'
import { renderState } from './render'
import { formatDurationIn } from './shared/format'

export type RequestInfo = {
  locale: string
  /** The signed-in user (set by @cslug/auth), or null. */
  user: unknown
  csrfToken: string
  /** First error message per field, after a failed form post. */
  errors: Record<string, string>
  /** The previous form input. */
  old: Record<string, unknown>
  /** Flashed messages (`success`, `error`, …). */
  flash: Record<string, unknown>
  url: string
  /** This page in each supported locale (for `<link rel="alternate" hreflang>`), when its route has `:locale`. */
  alternates: { locale: string; url: string }[]
}

/** The current request, read-only, on the server. Inside a hydrated island it throws: pass props instead. */
export function useRequest(): RequestInfo {
  const ctx = renderState()?.http
  if (!ctx) {
    return {
      locale: currentLocale(),
      user: null,
      csrfToken: '',
      errors: {},
      old: {},
      flash: {},
      url: '',
      alternates: [],
    }
  }
  const hasSession = ctx.session.constructor.name !== 'MissingSession'
  const errors = hasSession
    ? Object.fromEntries(Object.entries(ctx.session.errors()).map(([k, v]) => [k, v[0] ?? '']))
    : {}
  const url = new URL(ctx.request.url)
  return {
    locale: ctx.locale,
    user: (ctx as unknown as { user?: unknown }).user ?? null,
    csrfToken: hasSession ? ctx.session.token() : '',
    errors,
    old: hasSession ? (ctx.session.old() as Record<string, unknown>) : {},
    flash: hasSession ? ctx.session.flashed() : {},
    url: url.toString(),
    alternates: alternates(ctx, url),
  }
}

function alternates(
  ctx: NonNullable<ReturnType<typeof renderState>>['http'] & object,
  url: URL,
): RequestInfo['alternates'] {
  if (!ctx.routeName || ctx.params.locale === undefined) return []
  const app = currentApp()
  const locales = app.resolve(Translator).locales
  if (!app.resolve(Router).byName(ctx.routeName)) return []
  return locales.map((locale) => ({
    locale,
    url: httpRoute(ctx.routeName as string, { ...ctx.params, locale }, { absolute: true }) + url.search,
  }))
}

/** Translations in the current locale: `t(key, params)`, `tr(translatedColumn)`, and the formatters. */
export function useT() {
  const locale = currentLocale()
  return {
    locale,
    t: (key: string, params?: Record<string, unknown>) => t(key, params, locale),
    tr: (value: Partial<Record<string, string>> | string | null | undefined) => tr(value, locale),
    formatMoney: (amount: Parameters<typeof formatMoney>[0], currency?: string) =>
      formatMoney(amount, currency, locale),
    formatDate: (value: Parameters<typeof formatDate>[0], style?: Parameters<typeof formatDate>[1]) =>
      formatDate(value, style, { locale }),
  }
}

/** A URL from a route name (same as @cslug/http's `route`; also available in the browser). */
export const route = (name: string, params?: Record<string, unknown>, options?: UrlOptions): string =>
  httpRoute(name, params, options)

/** Minutes as "2 h 30 min" (locale-aware unit names via Intl). */
export const formatDuration = (minutes: number, locale = currentLocale()): string => formatDurationIn(locale, minutes)

export { formatDate, formatMoney }
