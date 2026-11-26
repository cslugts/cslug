/**
 * Lockstep releases for all @cslug/* packages.
 *
 *   bun scripts/release.ts version 0.1.0     set every package to 0.1.0 (commit + tag v0.1.0 afterwards)
 *   bun scripts/release.ts publish           publish all packages in dependency order (CI, on a v* tag)
 *   bun scripts/release.ts publish --dry-run show what would be published
 *
 * In the repo, internal peers stay "workspace:*". At publish time each package.json is rewritten with the exact
 * release version (lockstep), published with npm, then restored.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { topoOrder } from './package-graph'

const root = join(import.meta.dir, '..')
const pkgPath = (name: string) => join(root, 'packages', name, 'package.json')
type Pkg = { name: string; version: string; peerDependencies?: Record<string, string> }
const read = (name: string) => JSON.parse(readFileSync(pkgPath(name), 'utf8')) as Pkg
const write = (name: string, pkg: Pkg) => writeFileSync(pkgPath(name), `${JSON.stringify(pkg, null, 2)}\n`)

export function isVersion(v: string | undefined): v is string {
  return !!v && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v)
}

/** Replace workspace:* peers with the exact release version. Pure, for tests. */
export function pinWorkspacePeers(pkg: Pkg, version: string): Pkg {
  const peers = Object.fromEntries(
    Object.entries(pkg.peerDependencies ?? {}).map(([k, v]) => [k, v.startsWith('workspace:') ? version : v]),
  )
  return { ...pkg, ...(pkg.peerDependencies ? { peerDependencies: peers } : {}) }
}

function setVersion(version: string) {
  for (const name of topoOrder()) write(name, { ...read(name), version })
  console.log(
    `✔ All packages set to ${version}. Next: update CHANGELOG.md, commit, then \`git tag v${version} && git push --tags\`.`,
  )
}

async function publish(dryRun: boolean) {
  const order = topoOrder()
  const versions = new Set(order.map((n) => read(n).version))
  if (versions.size !== 1) throw new Error(`Packages are not in lockstep: ${[...versions].join(', ')}`)
  const [version] = [...versions] as [string]
  const provenance = process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : []

  for (const name of order) {
    const original = readFileSync(pkgPath(name), 'utf8')
    const published = Bun.spawnSync(['npm', 'view', `@cslug/${name}@${version}`, 'version'], { stderr: 'ignore' })
    if (published.stdout.toString().trim() === version) {
      console.log(`- @cslug/${name}@${version} already published, skipping`)
      continue
    }
    try {
      write(name, pinWorkspacePeers(read(name), version))
      const args = ['npm', 'publish', '--access', 'public', ...provenance, ...(dryRun ? ['--dry-run'] : [])]
      console.log(`→ ${dryRun ? '[dry-run] ' : ''}@cslug/${name}@${version}`)
      // stdin too: npm asks for the 2FA code (or opens the browser) only when it can talk to a terminal
      const res = Bun.spawnSync(args, { cwd: join(root, 'packages', name), stdio: ['inherit', 'inherit', 'inherit'] })
      if (res.exitCode !== 0) throw new Error(`npm publish failed for @cslug/${name}`)
    } finally {
      writeFileSync(pkgPath(name), original)
    }
  }
  console.log(`✔ ${dryRun ? 'Dry run complete' : `Published ${order.length} packages at ${version}`}`)
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'version' && isVersion(arg)) setVersion(arg)
  else if (cmd === 'publish') await publish(process.argv.includes('--dry-run'))
  else {
    console.error('Usage: bun scripts/release.ts version <x.y.z> | publish [--dry-run]')
    process.exit(1)
  }
}
