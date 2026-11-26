/**
 * The asset build (`cslug build`, `cslug dev`): `Bun.build` for the browser with cslug's plugins. Entries are
 * the app's client entries plus **one entry per island component**, so each island is its own chunk and the
 * manifest maps island ids to chunk URLs. Vue itself becomes a shared chunk.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { BunPlugin } from 'bun'
import { parse } from 'vue/compiler-sfc'
import { compileScss, componentId, SfcCache } from './compiler'
import type { AssetManifest } from './render'

export type BuildOptions = {
  root: string
  /** Client entries by name (default `{ client: 'resources/client.ts' }`). */
  entries?: Record<string, string>
  /** Development: readable output, no hashes, source maps, Vue warnings. */
  dev?: boolean
  tailwind?: boolean
  /** Default `public/build`, served at `/build`. */
  outdir?: string
  publicPath?: string
}

export type BuildResult = { manifest: AssetManifest; ms: number; files: string[] }

const vueFiles = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? vueFiles(p) : f.endsWith('.vue') ? [p] : []
      })

type Node = {
  type: number
  tag?: string
  tagType?: number
  props?: { type: number; name: string }[]
  children?: Node[]
}

/** Component files used with `hydrate` anywhere under resources/ (resolved through the importing file's imports). */
export function findIslands(root: string): string[] {
  const found = new Set<string>()
  for (const file of vueFiles(join(root, 'resources'))) {
    const source = readFileSync(file, 'utf8')
    if (!source.includes('hydrate')) continue
    const { descriptor } = parse(source, { filename: file })
    const tags = new Set<string>()
    const visit = (nodes: Node[] = []) => {
      for (const n of nodes) {
        if (n.type === 1 && n.tagType === 1 && n.tag && n.props?.some((p) => p.type === 6 && p.name === 'hydrate'))
          tags.add(n.tag)
        visit(n.children)
      }
    }
    visit((descriptor.template?.ast as Node | undefined)?.children)
    const script = `${descriptor.script?.content ?? ''}\n${descriptor.scriptSetup?.content ?? ''}`
    for (const tag of tags) {
      const pascal = tag.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())
      const spec = new RegExp(`import\\s+${pascal}\\s+from\\s+['"]([^'"]+\\.vue)['"]`).exec(script)?.[1]
      if (!spec)
        throw new Error(`${relative(root, file)}: <${tag} hydrate> must be imported from a .vue file in this component`)
      found.add(Bun.resolveSync(spec, dirname(file)))
    }
  }
  return [...found].sort()
}

/** `@/…` → `resources/…` in imports. */
export const aliasPlugin = (root: string): BunPlugin => ({
  name: 'cslug-alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: Bun.resolveSync(join(root, 'resources', args.path.slice(2)), root),
    }))
  },
})

function vuePlugins(root: string, dev: boolean): BunPlugin[] {
  const cache = new SfcCache()
  return [
    aliasPlugin(root),
    {
      name: 'cslug-vue-client',
      setup(build) {
        // the component CSS is rendered into the page by the server, so the client build only needs the code
        build.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
          contents: cache.get(path, { root, ssr: false, production: !dev }).code,
          loader: 'ts',
        }))
      },
    },
    {
      name: 'cslug-scss',
      setup(build) {
        build.onLoad({ filter: /\.scss$/ }, ({ path }) => ({
          contents: compileScss(readFileSync(path, 'utf8'), path, root),
          loader: 'css',
        }))
      },
    },
  ]
}

/** Build the client entries and the islands; write `manifest.json`. */
export async function buildAssets(options: BuildOptions): Promise<BuildResult> {
  const started = performance.now()
  const { root } = options
  const dev = options.dev ?? false
  const outdir = join(root, options.outdir ?? 'public/build')
  const publicPath = options.publicPath ?? '/build/'
  const entries = options.entries ?? { client: 'resources/client.ts' }
  const islands = findIslands(root)
  const plugins = vuePlugins(root, dev)
  if (options.tailwind) {
    const tailwind = (await import(Bun.resolveSync('bun-plugin-tailwind', root))).default as BunPlugin
    plugins.push(tailwind)
  }
  const entryFiles = Object.values(entries).map((e) => join(root, e))
  for (const e of entryFiles) if (!existsSync(e)) throw new Error(`Asset entry ${relative(root, e)} does not exist`)

  rmSync(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: [...entryFiles, ...islands],
    root,
    outdir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: !dev,
    sourcemap: dev ? 'linked' : 'none',
    conditions: ['browser'],
    // no publicPath: Bun would prefix it to relative chunk paths (/build/../chunks/…); relative imports resolve
    // correctly from wherever the entry is served
    naming: dev
      ? { entry: '[dir]/[name].[ext]', chunk: 'chunks/[name]-[hash].[ext]', asset: 'assets/[name]-[hash].[ext]' }
      : {
          entry: '[dir]/[name]-[hash].[ext]',
          chunk: 'chunks/[name]-[hash].[ext]',
          asset: 'assets/[name]-[hash].[ext]',
        },
    define: {
      'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: dev ? 'true' : 'false',
    },
    plugins,
    // report the errors ourselves: with `throw`, Bun only says "Bundle failed"
    throw: false,
  })
  if (!result.success)
    throw new AggregateError(
      result.logs,
      `Asset build failed:\n${result.logs
        .map((l) => {
          // ResolveMessage.referrer: the file that made the import (a server module reaching a browser bundle)
          const where = (l as { referrer?: string }).referrer || l.position?.file
          return `${l.message}${where ? ` (in ${relative(root, where)}${l.position?.line ? `:${l.position.line}` : ''})` : ''}`
        })
        .join('\n')}`,
    )

  // map outputs back to their entry: "resources/components/day-card-1a2b3c4d.js" → "resources/components/day-card"
  const stem = (file: string) =>
    relative(outdir, file)
      .replace(/\\/g, '/')
      .replace(dev ? /\.(js|css)$/ : /-[a-z0-9]{8}\.(js|css)$/, '')
  const url = (file: string) => publicPath + relative(outdir, file).replace(/\\/g, '/')
  const byStem = new Map<string, { js?: string; css: string[] }>()
  for (const out of result.outputs) {
    if (out.kind !== 'entry-point' && !(out.kind === 'asset' && out.path.endsWith('.css'))) continue
    const s = stem(out.path)
    const item = byStem.get(s) ?? { css: [] }
    if (out.path.endsWith('.css')) item.css.push(url(out.path))
    else if (out.path.endsWith('.js')) item.js = url(out.path)
    byStem.set(s, item)
  }
  const manifest: AssetManifest = { entries: {}, islands: {} }
  for (const [name, entry] of Object.entries(entries)) {
    const item = byStem.get(entry.replace(/\.[jt]sx?$/, ''))
    manifest.entries[name] = { js: item?.js, css: item?.css ?? [] }
  }
  for (const island of islands) {
    const js = byStem.get(
      relative(root, island)
        .replace(/\\/g, '/')
        .replace(/\.vue$/, ''),
    )?.js
    if (js) manifest.islands[componentId(island, root)] = js
  }
  mkdirSync(outdir, { recursive: true })
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return {
    manifest,
    ms: Math.round(performance.now() - started),
    files: result.outputs.map((o) => relative(root, o.path)),
  }
}
