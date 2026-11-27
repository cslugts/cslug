import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, flag } from '@cslug/core'

const STUBS = join(import.meta.dir, '../../stubs/add')

/** What `cslug add <name>` installs and wires. `config`: the `config/<key>.ts` written from `<stub>.config.stub`. */
type Addition = {
  packages: string[]
  dev?: boolean
  providers?: { from: string; names: string[] }
  config?: string
  files?: Record<string, string>
  processes?: string
  next?: string
}

export const ADDITIONS: Record<string, Addition> = {
  queue: {
    packages: ['@cslug/queue'],
    providers: { from: '@cslug/queue', names: ['QueueProvider', 'ScheduleProvider'] },
    config: 'queue',
    files: { 'routes/schedule.ts': 'schedule.stub' },
    processes: "    worker: [{ queues: ['default'], concurrency: 5 }],\n    scheduler: true,\n",
  },
  mail: { packages: ['@cslug/mail'], providers: { from: '@cslug/mail', names: ['MailProvider'] }, config: 'mail' },
  storage: {
    packages: ['@cslug/storage'],
    providers: { from: '@cslug/storage', names: ['StorageProvider'] },
    config: 'storage',
  },
  notification: {
    packages: ['@cslug/notification'],
    providers: { from: '@cslug/notification', names: ['NotificationProvider'] },
    config: 'notification',
    next: 'cslug migrate (creates cslug_notifications and cslug_notification_deliveries)',
  },
  webhook: {
    packages: ['@cslug/webhook'],
    providers: { from: '@cslug/webhook', names: ['WebhookProvider'] },
    config: 'webhooks',
    next: 'cslug migrate (creates cslug_webhook_inbox)',
  },
  search: {
    packages: ['@cslug/search'],
    providers: { from: '@cslug/search', names: ['SearchProvider'] },
    next: 'cslug migrate (adds unaccent, pg_trgm and the cslug_<language> search configurations)',
  },
  ai: {
    packages: ['@cslug/ai'],
    providers: { from: '@cslug/ai', names: ['AiProvider'] },
    config: 'ai',
    next: 'with @cslug/database: cslug migrate (creates cslug_ai_conversations, cslug_ai_messages and cslug_ai_runs)',
  },
  tailwind: {
    packages: ['tailwindcss@^4.0.0', 'bun-plugin-tailwind'],
    dev: true,
    files: { 'resources/styles/tailwind.css': 'tailwind.css.stub' },
  },
}

/** The version of every @cslug/* package of this release (they share one). */
const VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')).version

/**
 * `cslug add queue,mail`: installs the packages (at this CLI's version), adds their providers to
 * `bootstrap/providers.ts`, writes their config file and lists it in `config/index.ts`. Running it twice changes
 * nothing; a file it cannot edit is reported with what to add by hand.
 */
export class AddCommand extends Command {
  static signature = 'add'
  static description = `Add a package to the app: ${Object.keys(ADDITIONS).join(', ')}`
  static boot = false
  static args = {
    names: arg.string().describe('One or more, comma-separated: queue,mail'),
    install: flag.boolean().default(true).describe('Run bun add (--no-install to only edit files)'),
  }

  async handle({ names, install }: Command.Args<typeof AddCommand>) {
    const wanted = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    const unknown = wanted.filter((n) => !ADDITIONS[n])
    if (unknown.length) {
      this.error(`Unknown: ${unknown.join(', ')}. Available: ${Object.keys(ADDITIONS).join(', ')}`)
      return 1
    }
    for (const name of wanted) if (!(await this.add(name, ADDITIONS[name] as Addition, install))) return 1
    return 0
  }

  private async add(name: string, a: Addition, install: boolean): Promise<boolean> {
    if (install) {
      const specs = a.packages.map((p) => (p.startsWith('@cslug/') ? `${p}@${VERSION}` : p))
      const proc = Bun.spawn(['bun', 'add', ...(a.dev ? ['-d'] : []), ...specs], {
        cwd: this.app.rootDir,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      if ((await proc.exited) !== 0) {
        this.error(`bun add failed for ${name}`)
        return false
      }
    }
    if (a.providers) this.addProviders(a.providers)
    if (a.config) {
      this.generate(STUBS, `${a.config}.config.stub`, `config/${a.config}.ts`, {})
      this.addConfig(a.config)
    }
    for (const [target, stub] of Object.entries(a.files ?? {})) this.generate(STUBS, stub, target, {})
    if (a.processes) this.edit('cslug.config.ts', /( *processes: \{\n(?:.*web.*\n)?)/, `$1${a.processes}`, 'worker:')
    if (name === 'tailwind') {
      this.edit('cslug.config.ts', /tailwind: false/, 'tailwind: true', 'tailwind: true')
      this.edit(
        'resources/client.ts',
        /(import '.\/styles\/[^']+'\n)/,
        "$1import './styles/tailwind.css'\n",
        'tailwind.css',
      )
    }
    this.success(`${name} added${a.next ? `; next: ${a.next}` : ''}`)
    return true
  }

  private addProviders({ from, names }: { from: string; names: string[] }) {
    const missing = names.filter((n) => !this.read('bootstrap/providers.ts')?.includes(n))
    if (!missing.length) return
    const imported = `import { ${missing.join(', ')} } from '${from}'\n`
    this.edit('bootstrap/providers.ts', /((?:^import .*\n)+)/m, `$1${imported}`, imported.trim())
    // before the app's own provider (it may use what the package binds), else at the end of the list
    const entries = missing.map((n) => `  ${n},\n`).join('')
    const text = this.read('bootstrap/providers.ts') ?? ''
    if (/^ *AppServiceProvider,/m.test(text))
      this.edit('bootstrap/providers.ts', /^( *AppServiceProvider,)/m, `${entries}$1`)
    else
      this.edit('bootstrap/providers.ts', /(export const providers = \[[\s\S]*?)(\n\])/, `$1\n${entries.trimEnd()}$2`)
  }

  private addConfig(key: string) {
    if (new RegExp(`^import ${key} from`, 'm').test(this.read('config/index.ts') ?? '')) return
    this.edit('config/index.ts', /((?:^import \w+ from ["']\.\/\w+["']\n)+)/m, `$1import ${key} from './${key}'\n`)
    this.edit('config/index.ts', /(export const configs = \{[^}]*?)(\s*\})/, `$1, ${key}$2`)
  }

  private read(path: string): string | undefined {
    const file = join(this.app.rootDir, path)
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }

  /** Replace `pattern` in `path` unless `done` is already there; when the pattern is not found, say what to add. */
  private edit(path: string, pattern: RegExp, replacement: string, done?: string) {
    const text = this.read(path)
    if (text === undefined || (done && text.includes(done))) return
    if (!pattern.test(text)) {
      this.warn(`could not edit ${path}: add ${replacement.replace(/\$\d/g, '').trim()} by hand`)
      return
    }
    writeFileSync(join(this.app.rootDir, path), text.replace(pattern, replacement))
    this.info(`updated ${path}`)
  }
}
