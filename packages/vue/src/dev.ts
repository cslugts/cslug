import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import { type Application, Logger } from '@cslug/core'
import type { RouteRegistrar } from '@cslug/http'
import type { BunPlugin } from 'bun'
import { parse } from 'vue/compiler-sfc'
import { type BuildOptions, buildAssets, vuePlugins } from './build'
import { componentId } from './compiler'
import { refreshComponentStyles, reloadComponent } from './loader'

const LIVE = '/__cslug/live'
let state: { hmr: boolean } | undefined
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()

/** The live endpoint and whether HMR is on, when `cslug dev` runs (CSLUG_DEV=1); else undefined. */
export const liveConfig = () => (state ? { url: LIVE, hmr: state.hmr } : undefined)

function broadcast(event: 'reload' | 'css' | 'vue', data: object = {}): void {
  const chunk = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  for (const c of clients) {
    try {
      c.enqueue(chunk)
    } catch {
      clients.delete(c)
    }
  }
}

/** What a `.vue` change touched: the script (remount), the template only (re-render, state kept) or the styles. */
type Kind = 'reload' | 'rerender' | 'style' | 'none'
type Parts = { script: string; template: string; style: string }

function sfcParts(file: string): Parts | undefined {
  try {
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
    const scoped = descriptor.styles.some((s) => s.scoped)
    return {
      // `scoped` changes the scope id the template is compiled with
      script: [descriptor.script?.content, descriptor.scriptSetup?.content, descriptor.scriptSetup?.lang, scoped].join(
        '\0',
      ),
      template: descriptor.template?.content ?? '',
      style: descriptor.styles.map((s) => `${s.lang}\0${s.scoped}\0${s.content}`).join('\0'),
    }
  } catch {
    return undefined
  }
}

const vueFiles = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? vueFiles(p) : f.endsWith('.vue') ? [p] : []
      })

/**
 * Hot module for one changed `.vue` file: the component alone, with `vue` and `@cslug/vue` taken from the page
 * (`client/hmr.ts`) and the components it imports taken from the page's registry when they are loaded there.
 */
async function buildHot(file: string, options: BuildOptions, n: number): Promise<string> {
  const { root } = options
  const outdir = join(root, options.outdir ?? 'public/build', 'hmr')
  const publicPath = `${options.publicPath ?? '/build/'}hmr/`
  const globals: Record<string, string[]> = {
    vue: Object.keys(await import('vue')),
    // by URL: a static path would pull the browser entry into apps' server type-check
    '@cslug/vue': Object.keys(await import(new URL('./client/index.ts', import.meta.url).href)),
  }
  const shared: BunPlugin = {
    name: 'cslug-hot',
    setup(build) {
      build.onResolve({ filter: /^(vue|@cslug\/vue)$/ }, (args) => ({ path: args.path, namespace: 'cslug-global' }))
      build.onLoad({ filter: /.*/, namespace: 'cslug-global' }, ({ path }) => ({
        contents: [
          `const m = globalThis.__cslug_hmr[${JSON.stringify(path)}]`,
          `export const { ${(globals[path] ?? []).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k)).join(', ')} } = m`,
        ].join('\n'),
        loader: 'js',
      }))
      // components imported by the changed one: the page's definition when it has one (so their instances are kept)
      build.onResolve({ filter: /\.vue$/ }, (args) => {
        if (args.kind.startsWith('entry-point') || args.namespace === 'cslug-live') return undefined
        const path = args.path.startsWith('@/')
          ? Bun.resolveSync(join(root, 'resources', args.path.slice(2)), root)
          : Bun.resolveSync(args.path, dirname(args.importer))
        return { path, namespace: 'cslug-live' }
      })
      build.onLoad({ filter: /.*/, namespace: 'cslug-live' }, ({ path }) => ({
        contents: `import fresh from ${JSON.stringify(path)}\nexport default globalThis.__cslug_components?.[${JSON.stringify(componentId(path, root))}] ?? fresh`,
        loader: 'js',
      }))
      build.onResolve({ filter: /\.vue$/, namespace: 'cslug-live' }, (args) => ({ path: args.path }))
    },
  }
  const result = await Bun.build({
    entrypoints: [file],
    root,
    outdir,
    target: 'browser',
    format: 'esm',
    conditions: ['browser'],
    naming: `[name]-${n}.[ext]`,
    define: { 'process.env.NODE_ENV': '"development"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false' },
    plugins: [shared, ...vuePlugins(root, true)],
    throw: false,
  })
  const out = result.outputs.find((o) => o.kind === 'entry-point')
  if (!result.success || !out) throw new AggregateError(result.logs, `Hot update of ${relative(root, file)} failed`)
  return publicPath + relative(outdir, out.path).replace(/\\/g, '/')
}

/**
 * Development: build the assets now, rebuild when resources/ changes, and tell open pages (SSE):
 * - a `.vue` file: patch the server's copy (pages render the new template), then hot-update the islands that use it
 *   (`hmr`), else reload the pages that rendered it;
 * - a stylesheet: swap the stylesheets and the component styles that `@use` it;
 * - anything else in resources/ (client `.ts`, images…): reload.
 * Server code outside resources/ restarts the process (`bun --watch`); pages reconnect and reload.
 */
export async function startDev(app: Application, options: BuildOptions & { hmr?: boolean }): Promise<() => void> {
  const hmr = options.hmr ?? true
  state = { hmr }
  const log = app.resolve(Logger)
  const resources = join(app.rootDir, 'resources')
  const known = new Map<string, Parts | undefined>()
  for (const f of vueFiles(resources)) known.set(f, sfcParts(f))
  let hot = 0

  const build = async () => {
    const { ms } = await buildAssets(options)
    log.info('vue.assets_built', { ms })
  }

  const updateVue = async (file: string): Promise<boolean> => {
    if (!existsSync(file)) return false
    const before = known.get(file)
    const after = sfcParts(file)
    const kind: Kind =
      !before || !after || before.script !== after.script
        ? 'reload'
        : before.template !== after.template
          ? 'rerender'
          : before.style !== after.style
            ? 'style'
            : 'none'
    if (kind === 'none') return true
    const server = await reloadComponent(file)
    const id = server?.id ?? componentId(file, app.rootDir)
    const url = hmr && kind !== 'style' ? await buildHot(file, options, ++hot) : undefined
    // only once it worked: a save caught half-written fails, and the next event must not look like "no change"
    known.set(file, after)
    broadcast('vue', { id, kind, ...(url ? { url } : {}), ...(server ? { css: server.css } : {}) })
    log.info('vue.hot_update', { component: id, kind: url ? kind : 'reload' })
    return true
  }

  const flush = async (changed: Set<string>) => {
    const files = [...changed]
    const vue = files.filter((f) => f.endsWith('.vue'))
    const styles = files.filter((f) => /\.s?css$/.test(f))
    const other = files.filter((f) => !vue.includes(f) && !styles.includes(f))
    try {
      await build()
      // every changed component is recompiled on the server, even when the pages reload anyway
      let reload = other.length > 0
      for (const f of vue) if (!(await updateVue(f))) reload = true
      if (reload) return broadcast('reload')
      if (styles.length) broadcast('css', { styles: refreshComponentStyles(known.keys()) })
    } catch (error) {
      log.error('vue.assets_failed', { error })
    }
  }

  try {
    await build()
  } catch (error) {
    log.error('vue.assets_failed', { error })
  }
  // a comment every few seconds keeps idle connections under Bun.serve's idle timeout (a drop would reload pages)
  const heartbeat = setInterval(() => {
    const ping = new TextEncoder().encode(': ping\n\n')
    for (const c of clients) {
      try {
        c.enqueue(ping)
      } catch {
        clients.delete(c)
      }
    }
  }, 5000)
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = new Set<string>()
  let running = Promise.resolve()
  const watcher = watch(resources, { recursive: true }, (_event, file) => {
    const name = basename(String(file ?? ''))
    // directories, editor swap and backup files
    if (!extname(name) || name.startsWith('.') || name.endsWith('~')) return
    pending.add(join(resources, String(file)))
    clearTimeout(timer)
    timer = setTimeout(() => {
      const batch = pending
      pending = new Set()
      running = running.then(() => flush(batch))
    }, 50)
  })
  return () => {
    clearInterval(heartbeat)
    clearTimeout(timer)
    watcher.close()
    for (const c of clients) c.close()
    clients.clear()
    state = undefined
  }
}

/** The SSE route pages connect to. */
export function liveRoute(r: RouteRegistrar): void {
  r.get(LIVE, () => {
    let self: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller
        clients.add(controller)
        controller.enqueue(new TextEncoder().encode(': connected\n\n'))
      },
      cancel() {
        clients.delete(self)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  })
}
