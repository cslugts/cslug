import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Command, flag } from '@cslug/core'
import { buildAssets } from './build'

/** Asset settings from cslug.config.ts (`assets`). */
export async function assetConfig(root: string): Promise<{ entries?: Record<string, string>; tailwind?: boolean }> {
  const path = join(root, 'cslug.config.ts')
  if (!existsSync(path)) return {}
  const config = (await import(path)).default as
    | { assets?: { entries?: Record<string, string>; tailwind?: boolean } }
    | undefined
  return config?.assets ?? {}
}

/** `cslug build`: minified, hashed assets in public/build with manifest.json. */
export class BuildCommand extends Command {
  static signature = 'build'
  static description = 'Build the browser assets (islands, client entries, styles) into public/build'
  static boot = false
  static args = { dev: flag.boolean().describe('Unminified, with source maps') }

  async handle({ dev }: Command.Args<typeof BuildCommand>) {
    const { manifest, ms, files } = await buildAssets({
      root: this.app.rootDir,
      dev,
      ...(await assetConfig(this.app.rootDir)),
    })
    this.success(`built ${files.length} files in ${ms} ms (${Object.keys(manifest.islands).length} islands)`)
    for (const [name, e] of Object.entries(manifest.entries))
      this.line(`  ${name}: ${[e.js, ...(e.css ?? [])].filter(Boolean).join(', ')}`)
  }
}

/** `cslug typecheck`: vue-tsc over .ts and .vue (templates and view() props included). */
export class TypecheckCommand extends Command {
  static signature = 'typecheck'
  static description = 'Type-check .ts and .vue files with vue-tsc'
  static boot = false

  async handle() {
    const bin = join(this.app.rootDir, 'node_modules/.bin/vue-tsc')
    if (!existsSync(bin)) {
      this.error('vue-tsc is not installed: bun add -d vue-tsc')
      return 1
    }
    const proc = Bun.spawn([bin, '--noEmit', '-p', 'tsconfig.json'], {
      cwd: this.app.rootDir,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const code = await proc.exited
    if (code === 0) this.success('no type errors')
    return code
  }
}
