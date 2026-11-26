/**
 * Spike (a): compile a .vue SFC for the server (SSR) or the browser, with cslug's island rewrite.
 *
 * - `<X hydrate="visible" :a="b" />` in a template is rewritten to
 *   `<CslugIsland :island-component="X" island-hydrate="visible" :a="b" />` before compiling (see rewriteIslands).
 * - Every compiled component gets `__islandId` (path relative to the resources root) so the server can tell the
 *   browser which chunk to load, and `__scopeId` so scoped CSS matches on both sides.
 */
import { readFileSync, existsSync } from 'node:fs'
import { relative } from 'node:path'
import { MagicString, compileScript, compileStyle, parse } from 'vue/compiler-sfc'

export type Compiled = { code: string; css: string; islandId: string; ms: number }

// Vue compiler-core AST node types (not exported by vue/compiler-sfc)
const ELEMENT = 1
const TEXT = 2
const COMPONENT = 1 // ElementTypes.COMPONENT
const ATTRIBUTE = 6

const pascal = (tag: string) => tag.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase())

type AstNode = {
  type: number
  tag?: string
  tagType?: number
  isSelfClosing?: boolean
  content?: string
  loc: { start: { offset: number }; end: { offset: number } }
  props?: { type: number; name: string; value?: { content: string }; loc: AstNode['loc'] }[]
  children?: AstNode[]
}

/**
 * Rewrite `<X hydrate="visible" …/>` to `<CslugIsland :island-component="X" island-hydrate="visible" …/>` in the
 * SFC *source*, before Vue compiles it. A compiler nodeTransform is not enough: Vue's SSR compiler resolves the
 * component on enter, before custom transforms run, so a tag rename there only works for the browser build.
 * Rewriting the source keeps the server and browser builds identical.
 */
export function rewriteIslands(source: string, filename: string): string {
  const { descriptor } = parse(source, { filename })
  const ast = descriptor.template?.ast as AstNode | undefined
  if (!ast) return source
  const out = new MagicString(source)
  const visit = (nodes: AstNode[]) => {
    for (const node of nodes) {
      if (node.type === ELEMENT && node.tagType === COMPONENT && node.tag) {
        const attr = node.props?.find((p) => p.type === ATTRIBUTE && p.name === 'hydrate')
        if (attr) {
          const slot = (node.children ?? []).filter((c) => !(c.type === TEXT && !c.content?.trim()))
          if (slot.length > 0) {
            throw new Error(`<${node.tag} hydrate> cannot receive slot content: slots are lost when an island hydrates`)
          }
          const start = node.loc.start.offset
          out.overwrite(start + 1, start + 1 + node.tag.length, 'CslugIsland')
          const mode = attr.value?.content ?? 'load'
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

export function compileSfc(filename: string, root: string, ssr: boolean): Compiled {
  const t0 = performance.now()
  const source = rewriteIslands(readFileSync(filename, 'utf8'), filename)
  const islandId = relative(root, filename).replace(/\.vue$/, '')
  const id = Bun.hash(islandId).toString(16).slice(0, 8)
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length) throw new Error(`${filename}: ${errors.map((e) => e.message).join('; ')}`)

  const scoped = descriptor.styles.some((s) => s.scoped)
  const scopeId = `data-v-${id}`
  const script = compileScript(descriptor, {
    id,
    inlineTemplate: true,
    genDefaultAs: '_sfc_main',
    fs: { fileExists: existsSync, readFile: (f) => readFileSync(f, 'utf8') },
    templateOptions: {
      ssr,
      compilerOptions: { scopeId: scoped ? scopeId : undefined },
    },
  })

  const css = descriptor.styles
    .map((s) => {
      const out = compileStyle({ source: s.content, filename, id: scopeId, scoped: s.scoped })
      if (out.errors.length) throw new Error(`${filename}: ${out.errors.join('; ')}`)
      return out.code
    })
    .join('\n')

  const code = [
    script.content,
    `_sfc_main.__islandId = ${JSON.stringify(islandId)}`,
    scoped ? `_sfc_main.__scopeId = ${JSON.stringify(scopeId)}` : '',
    `_sfc_main.__file = ${JSON.stringify(filename)}`,
    'export default _sfc_main',
  ].join('\n')

  return { code, css, islandId, ms: performance.now() - t0 }
}
