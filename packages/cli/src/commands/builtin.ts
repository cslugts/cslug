import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, type CommandClass, flag, names } from '@cslug/core'
import { DevCommand, StartCommand } from '../supervisor'
import { AddCommand } from './add'
import { AgentsSyncCommand } from './agents-sync'
import { DescribeCommand } from './describe'
import { McpDevCommand } from './mcp-dev'
import { ReplCommand } from './repl'

export const STUBS = join(import.meta.dir, '../../stubs')

/** `cslug list`: commands grouped by prefix. */
export class ListCommand extends Command {
  static signature = 'list'
  static description = 'List the commands'
  static boot = false
  static args = { json: flag.boolean().describe('Machine-readable output') }

  async handle({ json }: Command.Args<typeof ListCommand>) {
    const { CliKernel } = await import('../kernel')
    const group = (c: CommandClass) => (c.signature.includes(':') ? (c.signature.split(':')[0] as string) : '')
    // ungrouped commands first, then by group and name
    const commands = [...(await this.app.resolve(CliKernel).commands()).values()].sort(
      (a, b) => (group(a) ? 1 : 0) - (group(b) ? 1 : 0) || a.signature.localeCompare(b.signature),
    )
    if (json)
      return this.line(JSON.stringify(commands.map((c) => ({ name: c.signature, description: c.description ?? '' }))))
    this.line('Usage: cslug <command> [arguments] [options]   (cslug <command> --help)')
    let current = ''
    this.line()
    for (const c of commands) {
      const g = group(c)
      if (g !== current) {
        current = g
        this.line()
        this.info(g)
      }
      this.line(`  ${c.signature.padEnd(24)}${c.description ?? ''}`)
    }
  }
}

/** `cslug about`: versions and environment. */
export class AboutCommand extends Command {
  static signature = 'about'
  static description = 'Versions of Bun and the @cslug packages; environment'
  static boot = false
  static args = { json: flag.boolean() }

  handle({ json }: Command.Args<typeof AboutCommand>) {
    const pkg = (p: string) => {
      try {
        return JSON.parse(readFileSync(join(this.app.rootDir, 'node_modules', p, 'package.json'), 'utf8'))
          .version as string
      } catch {
        return undefined
      }
    }
    const scoped = [
      'core',
      'validation',
      'http',
      'vue',
      'database',
      'redis',
      'queue',
      'auth',
      'mail',
      'notification',
      'storage',
      'webhook',
      'ai',
      'cli',
      'testing',
    ]
    const versions = Object.fromEntries(scoped.map((p) => [`@cslug/${p}`, pkg(`@cslug/${p}`)]).filter(([, v]) => v))
    const info = {
      bun: Bun.version,
      env: this.app.config('app.env') ?? 'development',
      root: this.app.rootDir,
      packages: versions,
    }
    if (json) return this.line(JSON.stringify(info))
    this.table([{ bun: info.bun, env: String(info.env), root: info.root }])
    this.line()
    this.table(Object.entries(versions).map(([name, version]) => ({ package: name, version })))
    if (new Set(Object.values(versions)).size > 1)
      this.warn('The @cslug packages have different versions: install the same version of all of them.')
  }
}

const SECRET = /key|secret|password|token|credential|dsn/i
const redact = (value: unknown, key = ''): unknown => {
  if (typeof value === 'string' && SECRET.test(key)) return value ? '••••••' : ''
  if (typeof value === 'string' && /^[a-z]+:\/\/[^/]*:[^@/]+@/.test(value))
    return value.replace(/:\/\/([^:/]*):[^@/]+@/, '://$1:••••••@')
  if (typeof value === 'bigint') return `${value}n`
  if (Array.isArray(value)) return value.map((v) => redact(v))
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  return value
}

/** `cslug config:show [section]`, secrets hidden. */
export class ConfigShowCommand extends Command {
  static signature = 'config:show'
  static description = 'Show the resolved configuration (secrets hidden)'
  static boot = false
  static args = { section: arg.string().optional().describe('A section or dotted path, e.g. database or app.url') }

  handle({ section }: Command.Args<typeof ConfigShowCommand>) {
    const value = section ? this.app.config(section) : this.app.configs
    if (value === undefined) {
      this.error(`No config at "${section}"`)
      return 1
    }
    this.line(JSON.stringify(redact(value, section?.split('.').at(-1)), null, 2))
  }
}

/** `cslug key:generate`: a random APP_KEY, printed or written to `.env`. */
export class KeyGenerateCommand extends Command {
  static signature = 'key:generate'
  static description = 'Generate APP_KEY (printed, or written to .env with --write)'
  static boot = false
  static args = { write: flag.boolean().describe('Write it to .env (replacing an existing APP_KEY)') }

  handle({ write }: Command.Args<typeof KeyGenerateCommand>) {
    const key = `base64:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`
    if (!write) return this.line(key)
    const path = join(this.app.rootDir, '.env')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(
      path,
      /^APP_KEY=.*$/m.test(text)
        ? text.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
        : `${text}${text && !text.endsWith('\n') ? '\n' : ''}APP_KEY=${key}\n`,
    )
    this.success('APP_KEY written to .env')
  }
}

/**
 * `cslug key:rotate`: a new APP_KEY; the current one moves to APP_PREVIOUS_KEYS, so what it encrypted and signed
 * (encrypted columns, signed URLs, magic links, two-factor secrets) keeps working. Prints the remaining steps.
 */
export class KeyRotateCommand extends Command {
  static signature = 'key:rotate'
  static description = 'Rotate APP_KEY (the old key moves to APP_PREVIOUS_KEYS; --write edits .env)'
  static boot = false
  static args = { write: flag.boolean().describe('Edit .env (otherwise the new values are printed)') }

  handle({ write }: Command.Args<typeof KeyRotateCommand>) {
    const key = `base64:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`
    const path = join(this.app.rootDir, '.env')
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const current = /^APP_KEY=(.*)$/m.exec(text)?.[1]?.trim() || process.env.APP_KEY
    const previous = (/^APP_PREVIOUS_KEYS=(.*)$/m.exec(text)?.[1] ?? process.env.APP_PREVIOUS_KEYS ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
    if (!current) {
      this.error('No APP_KEY to rotate: run `cslug key:generate --write` first')
      return 1
    }
    const keys = [current, ...previous.filter((k) => k !== current)].join(',')
    if (write) {
      let next = /^APP_KEY=.*$/m.test(text)
        ? text.replace(/^APP_KEY=.*$/m, `APP_KEY=${key}`)
        : `${text}APP_KEY=${key}\n`
      next = /^APP_PREVIOUS_KEYS=.*$/m.test(next)
        ? next.replace(/^APP_PREVIOUS_KEYS=.*$/m, `APP_PREVIOUS_KEYS=${keys}`)
        : next.replace(/^(APP_KEY=.*)$/m, `$1\nAPP_PREVIOUS_KEYS=${keys}`)
      writeFileSync(path, next)
      this.success('.env: new APP_KEY, the old one first in APP_PREVIOUS_KEYS')
    } else {
      this.line(`APP_KEY=${key}`)
      this.line(`APP_PREVIOUS_KEYS=${keys}`)
    }
    this.line('')
    this.line('Next:')
    this.line('  1. Set both variables on every process (web, worker, scheduler) and deploy.')
    this.line('     Values encrypted or signed with the old key keep working.')
    this.line('  2. cslug db:reencrypt   re-encrypts encrypted columns with the new key.')
    this.line('  3. Once signed URLs and magic links made before the rotation have expired, remove the old key')
    this.line('     from APP_PREVIOUS_KEYS.')
    return 0
  }
}

const makeArgs = {
  name: arg.string().describe('Name, optionally in a folder: admin/Claim'),
  force: flag.boolean().describe('Overwrite'),
}

/** A generator: `make:<kind> Name` → `<dir>/<name>-<suffix>.ts` from `stubs/<kind>.stub`. */
export function generator(
  kind: string,
  dir: string,
  description: string,
  suffix = kind,
  stubDir = STUBS,
): CommandClass {
  return class extends Command {
    static signature = `make:${kind}`
    static description = description
    static boot = false
    static args = makeArgs
    handle({ name, force }: Command.Args<{ args: typeof makeArgs }>) {
      // a test is `claims.test.ts` (what `bun test` runs), the others `escrow-service.ts`
      const n = kind === 'test' ? names(name.replace(/[-_.]?test$/i, '')) : names(name, suffix)
      const file = kind === 'test' ? `${n.file}.test` : n.file
      return this.generate(stubDir, `${kind}.stub`, `${dir}/${file}.ts`, { ...n, class: n.class }, force) ? 0 : 1
    }
  }
}

export const builtinCommands: CommandClass[] = [
  ListCommand,
  AboutCommand,
  ConfigShowCommand,
  KeyGenerateCommand,
  KeyRotateCommand,
  AddCommand,
  DescribeCommand,
  McpDevCommand,
  AgentsSyncCommand,
  ReplCommand,
  StartCommand,
  DevCommand,
  generator('command', 'app/commands', 'Create a command class'),
  generator('provider', 'app/providers', 'Create a service provider'),
  generator('event', 'app/events', 'Create an event'),
  generator('listener', 'app/listeners', 'Create an event listener'),
  generator('service', 'app/services', 'Create a service class'),
  generator('test', 'tests', 'Create a test file', 'test'),
]
