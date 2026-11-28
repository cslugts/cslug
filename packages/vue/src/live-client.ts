/**
 * The development client, inlined into every page `cslug dev` renders (`liveScript()`): it runs as
 * `(liveClient)(config)`, so it must stay self-contained (no imports, nothing from the enclosing module).
 *
 * Events from `/__cslug/live` (SSE):
 * - `reload`: reload the page;
 * - `css`: swap the stylesheets, and the component styles this page rendered;
 * - `vue` `{ id, kind, url?, css? }`: a component changed. If the page's islands loaded it and HMR is on, import
 *   the hot module and hand it to Vue (`rerender` keeps the state, `reload` remounts the component); else reload the
 *   page if it rendered the component; else nothing (another page's component).
 * When the server comes back after a restart, the page reloads.
 */
export type LiveConfig = { url: string; hmr: boolean; modules: string[]; nonce?: string }

type Def = Record<string, unknown>
type HmrRuntime = { rerender(id: string, render: unknown): void; reload(id: string, def: Def): void }

export function liveClient(config: LiveConfig): void {
  const g = globalThis as unknown as { __cslug_components?: Record<string, Def>; __VUE_HMR_RUNTIME__?: HmrRuntime }
  const rendered = (id: string) => config.modules.includes(id)
  const setStyle = (id: string, css: string) => {
    // Array.from and forEach: apps may type-check without the DOM.Iterable lib
    let el = Array.from(document.querySelectorAll<HTMLStyleElement>('style[data-cslug]')).find(
      (s) => s.dataset.cslug === id,
    )
    if (!el) {
      el = document.createElement('style')
      el.dataset.cslug = id
      if (config.nonce) el.nonce = config.nonce
      document.head.append(el)
    }
    el.textContent = css
  }
  const source = new EventSource(config.url)
  let wasDown = false
  source.addEventListener('reload', () => location.reload())
  source.addEventListener('css', (e) => {
    const data = JSON.parse((e as MessageEvent<string>).data) as { styles?: Record<string, string> }
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
      link.href = link.href.replace(/(\?.*)?$/, `?t=${Date.now()}`)
    })
    for (const [id, css] of Object.entries(data.styles ?? {})) if (rendered(id)) setStyle(id, css)
  })
  source.addEventListener('vue', async (e) => {
    const data = JSON.parse((e as MessageEvent<string>).data) as {
      id: string
      kind: 'rerender' | 'reload' | 'style'
      url?: string
      css?: string
    }
    if (data.css !== undefined && rendered(data.id)) setStyle(data.id, data.css)
    if (data.kind === 'style') return
    const def = g.__cslug_components?.[data.id]
    const runtime = g.__VUE_HMR_RUNTIME__
    if (config.hmr && def && data.url && runtime) {
      try {
        const next = (await import(/* @vite-ignore */ data.url)).default as Def
        if (data.kind === 'rerender') {
          runtime.rerender(data.id, next.render)
          def.render = next.render
        } else {
          runtime.reload(data.id, next)
          for (const key of Object.keys(def)) if (key !== '__file' && !(key in next)) delete def[key]
          Object.assign(def, next)
        }
        console.info(`[cslug] hot updated ${data.id}`)
        return
      } catch (error) {
        console.error('[cslug] hot update failed, reloading', error)
      }
      location.reload()
      return
    }
    if (def || rendered(data.id)) location.reload()
  })
  source.onerror = () => {
    wasDown = true
  }
  source.onopen = () => {
    if (wasDown) location.reload()
    // connected: updates from now on reach this page (tests wait for it)
    document.documentElement.dataset.cslugLive = 'open'
  }
}

/** The inline `<script type="module">` that runs the client with `config`. */
export const liveScript = (config: LiveConfig): string =>
  `<script type="module"${config.nonce ? ` nonce="${config.nonce.replace(/[^\w+/=-]/g, '')}"` : ''}>(${liveClient.toString()})(${JSON.stringify(config).replace(/</g, '\\u003c')})</script>`
