#!/usr/bin/env bun
/**
 * `bun create cslug <dir> [--api | --web | --full] [--tailwind] [--no-install] [--no-git]`
 */
import { parseArgs } from 'node:util'
import { type Preset, scaffold, VERSION } from './scaffold'
import { newerRelease } from './update'

const USAGE = `Usage: bun create cslug <dir> [options]

  --web          pages, Vue islands and auth (default)
  --api          a JSON API: no views, no Vue
  --full         web + queue, scheduler, mail and storage
  --tailwind     add Tailwind CSS (with --web or --full)
  --no-install   do not run bun install
  --no-git       do not run git init
  --no-update-check
                 use this version even if a newer create-cslug is on npm`

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  allowNegative: true,
  options: {
    api: { type: 'boolean' },
    web: { type: 'boolean' },
    full: { type: 'boolean' },
    tailwind: { type: 'boolean' },
    install: { type: 'boolean', default: true },
    git: { type: 'boolean', default: true },
    'update-check': { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
  },
})

const presets = (['api', 'web', 'full'] as const).filter((p) => values[p])
const dir = positionals[0]
if (values.help || !dir || presets.length > 1) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}
const preset: Preset = presets[0] ?? 'web'

// Bun may run a create-cslug it cached long ago: the app would be pinned to that old release
if (values['update-check']) {
  const latest = await newerRelease(VERSION)
  if (latest) {
    console.log(`create-cslug ${VERSION} is not the latest release: running ${latest}`)
    const child = Bun.spawn([process.execPath, 'x', `create-cslug@${latest}`, ...Bun.argv.slice(2)], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, CSLUG_NO_UPDATE_CHECK: '1' },
    })
    process.exit(await child.exited)
  }
}

try {
  const files = await scaffold({ dir, preset, tailwind: values.tailwind })
  console.log(`✔ ${dir}: ${files.length} files (${preset}${values.tailwind ? ' + tailwind' : ''})`)
} catch (error) {
  console.error(`✗ ${(error as Error).message}`)
  process.exit(1)
}

const run = async (cmd: string[]) =>
  (await Bun.spawn(cmd, { cwd: dir, stdout: 'inherit', stderr: 'inherit' }).exited) === 0
if (values.install && !(await run(['bun', 'install']))) console.error('✗ bun install failed: run it in the app')
if (values.git) await run(['git', 'init', '--quiet'])

console.log(`
Next:
  cd ${dir}
  docker compose up -d
  ${values.install ? '' : 'bun install\n  '}bunx cslug migrate
  bunx cslug dev`)
