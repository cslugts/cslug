import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentApp, currentContext, currentLocale, Logger, Translator } from '@cslug/core'
import { type HttpContext, type Responsable, Router } from '@cslug/http'
import { Comment, type Component, createSSRApp, defineComponent, h, useSSRContext } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { PageData } from './client/data'
import { liveConfig } from './dev'
import { liveScript } from './live-client'
import { componentStyles } from './loader'
import { serialize } from './serialize'

/** What one render collects (Vue's SSR context). */
export type RenderState = {
  http?: HttpContext
  /** Components that rendered (their CSS goes into the page). */
  modules: Set<string>
  /** Islands on the page. */
  islands: Set<string>
  /** Translation namespaces the page's islands declared (`defineOptions({ lang })`). */
  lang: Set<string>
  /** Render islands as plain HTML (renderStandalone, mail). */
  static?: boolean
  dev: boolean
}

export const renderState = (): RenderState | undefined => useSSRContext<RenderState>()

/**
 * The server side of `<X hydrate="…">` (the compiler rewrites the tag to this). Renders the component with the
 * *serialized* props, exactly what the browser will get, so hydration matches. `hydrate="none"` and static
 * renders produce the component's HTML only.
 */
export const CslugIsland = defineComponent({
  name: 'CslugIsland',
  inheritAttrs: false,
  props: {
    islandComponent: { type: [Object, Function], required: true },
    islandHydrate: { type: String, default: 'load' },
    ssr: { type: Boolean, default: true },
  },
  setup(props, { attrs, slots }) {
    const state = renderState()
    return () => {
      const component = props.islandComponent as Component & { __cslugId?: string; __file?: string; lang?: string[] }
      const id = component.__cslugId
      if (!id) throw new Error('hydrate="…" was used on a component that is not a .vue file compiled by cslug')
      const data = serialize({ ...attrs }, state?.dev ? (p) => warn(`<${id} hydrate> prop ${p}`) : undefined)
      if (props.islandHydrate === 'none' || state?.static) return h(component, data)
      state?.islands.add(id)
      for (const ns of component.lang ?? []) state?.lang.add(ns)
      const marker = {
        'data-island': id,
        'data-hydrate': props.islandHydrate,
        'data-props': JSON.stringify(data),
        ...(props.ssr ? {} : { 'data-ssr': 'false' }),
      }
      return h('cslug-island', marker, [props.ssr ? h(component, data) : (slots.fallback?.() ?? null)])
    }
  },
})

const warn = (message: string) => {
  try {
    currentApp().resolve(Logger).warn('vue.island_props', { message })
  } catch {
    console.warn(message)
  }
}

/** `<Assets entry="client" />` in the layout's `<head>`: CSS, the CSRF meta tag, and JS only if the page has islands. */
export const Assets = defineComponent({
  // biome-ignore lint/style/useVueMultiWordComponentNames: the name guide 08 documents
  name: 'Assets',
  props: { entry: { type: String, default: 'client' } },
  setup(props) {
    return () => h(Comment, `cslug-assets:${props.entry}`)
  },
})

/** `public/build/manifest.json`, written by `cslug build` (and `cslug dev`). */
export type AssetManifest = {
  entries: Record<string, { js?: string; css?: string[] }>
  islands: Record<string, string>
}

let manifestCache: { path: string; mtime: number; value: AssetManifest } | undefined
/** `public/build/manifest.json` from `cslug build` (re-read when it changes); undefined before a build. */
export function readManifest(root: string): AssetManifest | undefined {
  const path = join(root, 'public/build/manifest.json')
  if (!existsSync(path)) return undefined
  const mtime = Bun.file(path).lastModified
  if (manifestCache?.path !== path || manifestCache.mtime !== mtime)
    manifestCache = { path, mtime, value: JSON.parse(readFileSync(path, 'utf8')) }
  return manifestCache.value
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** What `<Assets>` becomes once the whole page has rendered (only then is it known which islands it has). */
function assetsHtml(entry: string, state: RenderState, root: string): string {
  const manifest = readManifest(root)
  const out: string[] = []
  const token = state.http && !isMissing(state.http) ? state.http.session.token() : undefined
  if (token) out.push(`<meta name="csrf-token" content="${escapeAttr(token)}">`)
  const assets = manifest?.entries[entry]
  const nonce = nonceAttr(state)
  for (const css of assets?.css ?? []) out.push(`<link rel="stylesheet" href="${escapeAttr(css)}">`)
  out.push(componentCss(state))
  if (state.islands.size) {
    out.push(`<style${nonce}>cslug-island{display:contents}</style>`)
    if (assets?.js) {
      const data = pageData(state, manifest as AssetManifest)
      out.push(
        `<script type="application/json" id="cslug-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`,
      )
      for (const island of state.islands) {
        const chunk = manifest?.islands[island]
        if (chunk) out.push(`<link rel="modulepreload" href="${escapeAttr(chunk)}">`)
      }
      out.push(`<script type="module" src="${escapeAttr(assets.js)}"${nonce}></script>`)
    } else if (state.dev) {
      out.push(
        `<!-- cslug: this page has islands but public/build/manifest.json has no "${entry}" entry: run cslug dev or cslug build -->`,
      )
    }
  }
  out.push(devClient(state))
  return out.join('')
}

/**
 * The CSS of the components the page rendered: one `<style data-cslug>`, or under `cslug dev` one per component
 * (`data-cslug="<id>"`) so a change replaces just that one.
 */
function componentCss(state: RenderState): string {
  const ids = [...state.modules].filter((m) => componentStyles.get(m))
  if (!ids.length) return ''
  const nonce = nonceAttr(state)
  if (!liveConfig()) return `<style data-cslug${nonce}>${ids.map((m) => componentStyles.get(m)).join('\n')}</style>`
  return ids.map((m) => `<style data-cslug="${escapeAttr(m)}"${nonce}>${componentStyles.get(m)}</style>`).join('')
}

/** ` nonce="…"` when a CSP middleware gave this request a nonce (`csp()` from @cslug/security). */
const nonceAttr = (state: RenderState) => (state.http?.nonce ? ` nonce="${escapeAttr(state.http.nonce)}"` : '')

/** Under `cslug dev`: the live-reload and HMR client (live-client.ts), told which components the page rendered. */
function devClient(state: RenderState): string {
  const live = liveConfig()
  return live ? liveScript({ ...live, modules: [...state.modules], nonce: state.http?.nonce }) : ''
}

/** What islands need in the browser: locale, their translation namespaces, named routes, chunk URLs. */
function pageData(state: RenderState, manifest: AssetManifest): PageData {
  const app = currentApp()
  const translator = app.resolve(Translator)
  const locale = state.http?.locale ?? currentLocale()
  const messages: Record<string, string> = {}
  for (const ns of state.lang) Object.assign(messages, translator.messagesFor(ns, locale))
  const allowed = app.config<string[] | undefined>('vue.routes')
  const routes: PageData['routes'] = {}
  for (const r of app.resolve(Router).routes) {
    if (!r.name || (allowed && !allowed.some((p) => r.name === p || r.name?.startsWith(`${p}.`)))) continue
    routes[r.name] = r.domain ? { path: r.path, domain: r.domain } : { path: r.path }
  }
  const islands: Record<string, string> = {}
  for (const id of state.islands) if (manifest.islands[id]) islands[id] = manifest.islands[id] as string
  return {
    locale,
    chain: translator.chain(locale),
    messages,
    routes,
    appUrl: app.config<string | undefined>('app.url'),
    islands,
  }
}

const isMissing = (ctx: HttpContext) => !ctx.session.available

export type RenderOptions = { http?: HttpContext; static?: boolean; root?: string }

/** Render a page component to a full HTML document. */
export async function renderPage(
  page: Component,
  props: Record<string, unknown> = {},
  options: RenderOptions = {},
): Promise<{ html: string; state: RenderState }> {
  const app = currentApp()
  const root = options.root ?? app.rootDir
  const state: RenderState = {
    http: options.http ?? (currentContext()?.http as HttpContext | undefined),
    modules: new Set(),
    islands: new Set(),
    lang: new Set(),
    static: options.static,
    dev: app.config('app.env') !== 'production',
  }
  const vue = createSSRApp(page, props)
  vue.component('CslugIsland', CslugIsland)
  vue.component('Assets', Assets)
  let html = await renderToString(vue, state)
  let placed = false
  html = html.replace(/<!--cslug-assets:([\w-]+)-->/g, (_m, entry: string) => {
    placed = true
    return assetsHtml(entry, state, root)
  })
  // a page without <Assets> still gets its component CSS (and the dev client)
  if (!placed) {
    const head = componentCss(state)
    if (head) html = html.includes('</head>') ? html.replace('</head>', `${head}</head>`) : `${head}${html}`
    const client = devClient(state)
    if (client) html = html.includes('</body>') ? html.replace('</body>', `${client}</body>`) : `${html}${client}`
  }
  return { html: /^\s*<html[\s>]/i.test(html) ? `<!doctype html>${html}` : html, state }
}

type ViewListener = (page: Component, props: Record<string, unknown>, ctx: HttpContext) => void
const viewListeners = new Set<ViewListener>()

/** Be told of every page rendered by `view()` (the test kit's `assertView`). Returns an unsubscribe function. */
export function onView(listener: ViewListener): () => void {
  viewListeners.add(listener)
  return () => {
    viewListeners.delete(listener)
  }
}

/** `return view(ShowCircuit, { circuit, days })` from a controller. */
export class ViewResponse implements Responsable {
  constructor(
    readonly page: Component,
    readonly props: Record<string, unknown>,
    readonly init: { status?: number; headers?: Record<string, string> } = {},
  ) {}

  async toResponse(ctx: HttpContext): Promise<Response> {
    for (const listener of viewListeners) listener(this.page, this.props, ctx)
    const { html } = await renderPage(this.page, this.props, { http: ctx })
    const headers = new Headers(this.init.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8')
    return new Response(html, { status: this.init.status ?? 200, headers })
  }
}

/** Props of a page component, for `view()` type checking. */
type PropsOf<C> = C extends new (
  ...args: never[]
) => { $props: infer P }
  ? Omit<P, `on${string}` | 'key' | 'ref' | 'class' | 'style'>
  : Record<string, unknown>

/** Return a page from a handler: `return view(BookingShow, { booking })`. Props are typed from the page. */
export function view<C extends Component>(
  page: C,
  props: PropsOf<C> | Record<string, unknown> = {},
  init?: { status?: number; headers?: Record<string, string> },
): ViewResponse {
  return new ViewResponse(page, props as Record<string, unknown>, init)
}

/**
 * One self-contained HTML file (the offline trip pack): islands rendered as plain HTML, no scripts, the page's
 * CSS inlined, and `/`-rooted images from `public/` inlined as data URIs.
 */
export async function renderStandalone(page: Component, props: Record<string, unknown> = {}): Promise<string> {
  const app = currentApp()
  const { html } = await renderPage(page, props, { static: true })
  const publicDir = join(app.rootDir, 'public')
  return html
    .replace(/<meta name="csrf-token"[^>]*>/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<link rel="modulepreload"[^>]*>/g, '')
    .replace(/<link rel="stylesheet" href="(\/[^"]+)">/g, (m, href: string) => {
      const file = join(publicDir, href)
      return existsSync(file) ? `<style>${readFileSync(file, 'utf8')}</style>` : m
    })
    .replace(/(<img\b[^>]*\bsrc=")(\/[^"]+)(")/g, (m, a: string, src: string, b: string) => {
      const file = Bun.file(join(publicDir, src))
      if (!existsSync(join(publicDir, src))) return m
      return `${a}data:${file.type.split(';')[0]};base64,${Buffer.from(readFileSync(join(publicDir, src))).toString('base64')}${b}`
    })
}
