/**
 * Compile a `.vue` SFC for the server (SSR) or the browser, with cslug's island rewrite. Shared by the runtime
 * loader (server) and the `Bun.build` plugin (browser), so both sides compile identical input.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileScript, compileStyle, compileTemplate, MagicString, parse } from 'vue/compiler-sfc'

export type CompiledSfc = { code: string; css: string; id: string }
export type CompileOptions = {
  /** The app root; `@/` and island ids are relative to `<root>/resources`. */
  root: string
  ssr: boolean
  /** Production: no dev-only checks. */
  production?: boolean
}

// Vue compiler-core AST node types (not exported by vue/compiler-sfc)
const ELEMENT = 1
const TEXT = 2
const COMMENT = 3
const COMPONENT = 1
const ATTRIBUTE = 6
const DIRECTIVE = 7

type AstNode = {
  type: number
  tag?: string
  tagType?: number
  isSelfClosing?: boolean
  content?: string
  loc: { start: { offset: number }; end: { offset: number } }
  props?: {
    type: number
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
    loc: AstNode['loc']
  }[]
  children?: AstNode[]
}

const pascal = (tag: string) => tag.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())

/**
 * `<X hydrate="visible" …/>` → `<CslugIsland :island-component="X" island-hydrate="visible" …/>`, in the source,
 * before Vue compiles it (a compiler nodeTransform only reaches the browser build: the SSR compiler resolves
 * components first; see spikes/a-vue-islands). Slot content is an error, except a `#fallback` template, which
 * is shown until a `:ssr="false"` island mounts.
 */
export function rewriteIslands(source: string, filename: string): string {
  const { descriptor } = parse(source, { filename })
  const ast = descriptor.template?.ast as AstNode | undefined
  if (!ast) return source
  const out = new MagicString(source)
  const visit = (nodes: AstNode[]) => {
    for (const node of nodes) {
      if (node.type === ELEMENT && node.tagType === COMPONENT && node.tag && node.tag !== 'CslugIsland') {
        const attr = node.props?.find((p) => p.type === ATTRIBUTE && p.name === 'hydrate')
        const bound = node.props?.find((p) => p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'hydrate')
        if (bound)
          throw new Error(
            `${filename}: <${node.tag} :hydrate> must be a literal (hydrate="visible"): the build needs to see it`,
          )
        if (attr) {
          const mode = attr.value?.content ?? 'load'
          if (!/^(load|idle|visible|none|media:.+)$/.test(mode)) {
            throw new Error(`${filename}: <${node.tag} hydrate="${mode}">: use load, idle, visible, none or media:(…)`)
          }
          const content = (node.children ?? []).filter(
            (c) => c.type !== COMMENT && !(c.type === TEXT && !c.content?.trim()),
          )
          const onlyFallback = content.every(
            (c) =>
              c.tag === 'template' &&
              c.props?.some((p) => p.type === DIRECTIVE && p.name === 'slot' && p.arg?.content === 'fallback'),
          )
          if (content.length && !onlyFallback) {
            throw new Error(
              `${filename}: <${node.tag} hydrate> cannot receive slot content (it would be lost when the island hydrates); pass props instead`,
            )
          }
          const start = node.loc.start.offset
          out.overwrite(start + 1, start + 1 + node.tag.length, 'CslugIsland')
          out.overwrite(
            attr.loc.start.offset,
            attr.loc.end.offset,
            `:island-component="${pascal(node.tag)}" island-hydrate="${mode}"`,
          )
          if (!node.isSelfClosing) {
            const close = source.lastIndexOf(`</${node.tag}`, node.loc.end.offset)
            out.overwrite(close + 2, close + 2 + node.tag.length, 'CslugIsland')
          }
        }
      }
      if (node.children) visit(node.children)
    }
  }
  visit(ast.children ?? [])
  return out.toString()
}

/** The id of a component: its path under `resources/` without `.vue` (`components/day-card`). */
export function componentId(filename: string, root: string): string {
  const resources = join(root, 'resources')
  const base = filename.startsWith(resources) ? resources : root
  return relative(base, filename)
    .replace(/\\/g, '/')
    .replace(/\.vue$/, '')
}

/** SCSS → CSS with `sass` (optional peer), `@/` resolving to `resources/`. */
export function compileScss(source: string, filename: string, root: string): string {
  let sass: typeof import('sass')
  try {
    sass = createRequire(join(root, 'package.json'))('sass')
  } catch {
    throw new Error(`${filename}: <style lang="scss"> needs the sass package: bun add -d sass`)
  }
  const resources = join(root, 'resources')
  return sass.compileString(source, {
    url: pathToFileURL(filename),
    loadPaths: [resources, root],
    importers: [
      {
        findFileUrl: (url: string) =>
          url.startsWith('@/') ? new URL(pathToFileURL(join(resources, url.slice(2)))) : null,
      },
    ],
  }).css
}

/** Compile one `.vue` file to a module (server or client build), with its scoped CSS. */
export function compileSfc(filename: string, options: CompileOptions): CompiledSfc {
  const source = rewriteIslands(readFileSync(filename, 'utf8'), filename)
  const id = componentId(filename, options.root)
  const hash = Bun.hash(id).toString(16).slice(0, 8)
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length)
    throw new Error(`${filename}: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`)
  if (!descriptor.script && !descriptor.scriptSetup && !descriptor.template)
    throw new Error(`${filename}: empty component`)

  const scoped = descriptor.styles.some((s) => s.scoped)
  const scopeId = `data-v-${hash}`
  let code: string
  if (descriptor.script || descriptor.scriptSetup) {
    code = compileScript(descriptor, {
      id: hash,
      inlineTemplate: true,
      genDefaultAs: '_sfc_main',
      isProd: options.production,
      fs: { fileExists: existsSync, readFile: (f) => readFileSync(f, 'utf8') },
      templateOptions: { ssr: options.ssr, ssrCssVars: [], compilerOptions: { scopeId: scoped ? scopeId : undefined } },
    }).content
  } else {
    // template only: compile it alone
    const t = compileTemplate({
      source: descriptor.template?.content ?? '',
      filename,
      id: hash,
      ssr: options.ssr,
      ssrCssVars: [],
      scoped,
      compilerOptions: { scopeId: scoped ? scopeId : undefined },
    })
    if (t.errors.length) throw new Error(`${filename}: ${t.errors.join('; ')}`)
    code = `${t.code}\nconst _sfc_main = { ${options.ssr ? 'ssrRender' : 'render'} }`
  }

  const css = descriptor.styles
    .map((s) => {
      const lang = s.lang ?? 'css'
      if (lang !== 'css' && lang !== 'scss')
        throw new Error(`${filename}: <style lang="${lang}"> is not supported (use css or scss)`)
      const plain = lang === 'scss' ? compileScss(s.content, filename, options.root) : s.content
      const out = compileStyle({ source: plain, filename, id: scopeId, scoped: s.scoped, isProd: options.production })
      if (out.errors.length) throw new Error(`${filename}: ${out.errors.map((e) => e.message).join('; ')}`)
      return out.code
    })
    .join('\n')

  const lines = [
    code,
    `_sfc_main.__cslugId = ${JSON.stringify(id)}`,
    scoped ? `_sfc_main.__scopeId = ${JSON.stringify(scopeId)}` : '',
    options.production ? '' : `_sfc_main.__file = ${JSON.stringify(filename)}`,
  ]
  // server: record that this component rendered (its CSS goes into the page) and which namespaces islands need
  if (options.ssr) {
    lines.push(
      `import { useSSRContext as __cslugCtx } from 'vue'`,
      `const __cslugSetup = _sfc_main.setup`,
      `_sfc_main.setup = function (props, ctx) { const s = __cslugCtx(); if (s && s.modules) s.modules.add(${JSON.stringify(id)}); return __cslugSetup ? __cslugSetup.call(this, props, ctx) : undefined }`,
    )
  }
  lines.push('export default _sfc_main')
  return { code: lines.filter(Boolean).join('\n'), css, id }
}

/** Compiled results by file, reused while the file is unchanged. */
export class SfcCache {
  private readonly entries = new Map<string, { mtime: number; result: CompiledSfc }>()
  get(filename: string, options: CompileOptions): CompiledSfc {
    const key = `${options.ssr ? 's' : 'c'}:${filename}`
    const mtime = statSync(filename).mtimeMs
    const hit = this.entries.get(key)
    if (hit && hit.mtime === mtime) return hit.result
    const result = compileSfc(filename, options)
    this.entries.set(key, { mtime, result })
    return result
  }
}
