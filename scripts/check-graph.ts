/**
 * Verifies that packages match docs/packages.md (encoded in scripts/package-graph.ts):
 * - every packages/* folder is in the graph, and vice versa
 * - package.json peers match the graph exactly; no runtime `dependencies`
 * - source files only import allowed @cslug packages, no deep imports, no undeclared third-party packages
 * - the graph has no cycles
 *
 * Usage: bun scripts/check-graph.ts   (exit code 1 on problems)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { graph, topoOrder } from './package-graph'

/** Documented subpath exports; anything else under @cslug/<pkg>/… is a deep import. */
const ALLOWED_SUBPATHS = new Set(['@cslug/http/middleware', '@cslug/vue/build'])

type PackageJson = {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

export function checkGraph(root: string): string[] {
  const problems: string[] = []
  const packagesDir = join(root, 'packages')
  const folders = readdirSync(packagesDir).filter((f) => statSync(join(packagesDir, f)).isDirectory())

  for (const f of folders) if (!graph[f]) problems.push(`packages/${f} is not in scripts/package-graph.ts`)
  for (const name of Object.keys(graph))
    if (!folders.includes(name)) problems.push(`graph lists "${name}" but packages/${name} is missing`)

  try {
    topoOrder()
  } catch (e) {
    problems.push((e as Error).message)
  }

  for (const name of folders) {
    const spec = graph[name]
    if (!spec) continue
    const pkg = JSON.parse(readFileSync(join(packagesDir, name, 'package.json'), 'utf8')) as PackageJson
    const where = `packages/${name}/package.json`

    if (pkg.name !== `@cslug/${name}`) problems.push(`${where}: name must be "@cslug/${name}"`)
    if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
      problems.push(`${where}: runtime "dependencies" are not allowed (use peerDependencies)`)
    }

    const expected = new Map<string, boolean>() // peer → optional?
    for (const r of spec.requires) expected.set(`@cslug/${r}`, false)
    for (const o of spec.optional ?? []) expected.set(`@cslug/${o}`, true)
    for (const [ext, v] of Object.entries(spec.externalPeers ?? {})) expected.set(ext, v.optional === true)

    const peers = pkg.peerDependencies ?? {}
    const meta = pkg.peerDependenciesMeta ?? {}
    for (const [peer, optional] of expected) {
      if (!(peer in peers)) problems.push(`${where}: missing peer "${peer}"`)
      else if ((meta[peer]?.optional === true) !== optional) {
        problems.push(`${where}: peer "${peer}" must be ${optional ? 'optional' : 'required'}`)
      }
    }
    for (const peer of Object.keys(peers)) if (!expected.has(peer)) problems.push(`${where}: unexpected peer "${peer}"`)

    // imports in source files
    const allowedCslug = new Set([...spec.requires, ...(spec.optional ?? [])].map((p) => `@cslug/${p}`))
    const allowedExternal = new Set(Object.keys(spec.externalPeers ?? {}))
    for (const file of sourceFiles(join(packagesDir, name, 'src'))) {
      const rel = file.slice(root.length + 1)
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.') || spec.startsWith('node:') || spec === 'bun' || spec.startsWith('bun:')) continue
        if (spec.startsWith('@cslug/')) {
          const base = spec.split('/').slice(0, 2).join('/')
          if (base === `@cslug/${name}`)
            problems.push(`${rel}: imports its own package "${spec}"; use a relative import`)
          else if (!allowedCslug.has(base)) problems.push(`${rel}: imports "${spec}", which ${name} may not depend on`)
          else if (spec !== base && !ALLOWED_SUBPATHS.has(spec)) problems.push(`${rel}: deep import "${spec}"`)
          continue
        }
        const base = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec)
        if (!allowedExternal.has(base))
          problems.push(`${rel}: imports third-party "${spec}", not declared as an allowed peer`)
      }
    }
  }
  return problems
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|vue)$/.test(entry)) out.push(full)
  }
  return out
}

/** Static and dynamic import/export-from specifiers. Type-only imports count too: types must follow the graph. */
export function importSpecifiers(code: string): string[] {
  const specs: string[] = []
  const re =
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g
  for (const m of code.matchAll(re)) specs.push((m[1] ?? m[2] ?? m[3]) as string)
  return specs
}

if (import.meta.main) {
  const problems = checkGraph(join(import.meta.dir, '..'))
  if (problems.length > 0) {
    console.error(`✖ Package graph check failed (${problems.length}):`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`✔ Package graph OK (${Object.keys(graph).length} packages; publish order: ${topoOrder().join(' → ')})`)
}
