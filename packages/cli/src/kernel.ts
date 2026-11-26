import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Application,
  COMMANDS,
  Command,
  type CommandClass,
  ConsoleIO,
  CslugError,
  parseArgs,
  runInContext,
  UsageError,
} from '@cslug/core'
import { builtinCommands } from './commands/builtin'
import { commandHelp } from './io'

const isCommandClass = (v: unknown): v is CommandClass =>
  typeof v === 'function' && v.prototype instanceof Command && typeof (v as CommandClass).signature === 'string'

/**
 * Runs `cslug <command> [args]`: built-in commands, those the providers contribute (`this.commands([...])`), and
 * the app's own in `app/commands/`. Returns the exit code.
 */
export class CliKernel {
  private found?: Map<string, CommandClass>
  /** True after a long-running command started (`serve`, `start`): the process must stay alive. */
  keepAlive = false

  constructor(
    readonly app: Application,
    private readonly extra: readonly CommandClass[] = [],
  ) {
    app.instance(CliKernel, this)
  }

  private get io(): ConsoleIO {
    return this.app.resolve(ConsoleIO)
  }

  /** Built-in and package commands (no file imports). */
  private known(): Map<string, CommandClass> {
    this.app.registerProviders()
    const map = new Map<string, CommandClass>()
    for (const c of [...builtinCommands, ...(this.app.taggedTokens(COMMANDS) as CommandClass[]), ...this.extra])
      map.set(c.signature, c)
    return map
  }

  /** Every command, by signature, including the app's (later wins: the app can replace a built-in). */
  async commands(): Promise<Map<string, CommandClass>> {
    if (this.found) return this.found
    this.found = this.known()
    for (const c of await this.discover()) this.found.set(c.signature, c)
    return this.found
  }

  /** Command classes exported from `app/commands/**` (files named `*-command.ts`). */
  private async discover(): Promise<CommandClass[]> {
    const dir = join(this.app.rootDir, 'app/commands')
    if (!existsSync(dir)) return []
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/-command\.ts$/.test(f)) files.push(p)
      }
    }
    walk(dir)
    const found: CommandClass[] = []
    for (const f of files) {
      try {
        for (const v of Object.values(await import(f))) if (isCommandClass(v)) found.push(v)
      } catch (error) {
        // one broken command must not take down the others (or the generator you need to fix it)
        this.io.error(
          `! skipped ${f.slice(this.app.rootDir.length + 1)}: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }
    return found
  }

  async run(argv: readonly string[]): Promise<number> {
    try {
      return await this.dispatch(argv)
    } catch (error) {
      if (error instanceof UsageError) {
        this.io.error(`✗ ${error.message}\n`)
        return 2
      }
      const message =
        error instanceof CslugError
          ? error.message
          : error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
      this.io.error(`✗ ${message}\n`)
      return 1
    }
  }

  private async dispatch(argv: readonly string[]): Promise<number> {
    const [first, ...rest] = argv
    // app commands are imported only when needed: built-ins and package commands work even if one is broken
    const commands = first && this.known().has(first) && first !== 'list' ? this.known() : await this.commands()
    if (first === undefined || first === '--help' || first === '-h') return this.dispatch(['list'])
    if (first === '--version' || first === '-v') return this.dispatch(['about'])
    const cmd = commands.get(first)
    if (!cmd) {
      const close = [...commands.keys()].filter(
        (k) => k.startsWith(first.split(':')[0] ?? first) || distance(k, first) <= 2,
      )
      throw new UsageError(
        `Unknown command "${first}".${close.length ? ` Did you mean: ${close.slice(0, 5).join(', ')}?` : ''} Run \`cslug list\`.`,
      )
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      this.io.write(`${commandHelp(cmd)}\n`)
      return 0
    }
    let args: Record<string, unknown>
    try {
      args = parseArgs(cmd.args ?? {}, rest)
    } catch (e) {
      if (e instanceof UsageError) this.io.error(`✗ ${e.message}\n\n${commandHelp(cmd)}\n`)
      if (e instanceof UsageError) return 2
      throw e
    }
    if (cmd.boot !== false) await this.app.start({ signals: !!cmd.longRunning })
    const scope = this.app.createScope()
    try {
      const code = await runInContext({ app: this.app, scope, requestId: `cli:${cmd.signature}` }, async () => {
        const instance = scope.build(cmd as never) as { handle?: (args: unknown) => unknown }
        if (typeof instance.handle !== 'function')
          throw new CslugError('cli.no_handle', `${cmd.name} has no handle(args) method`)
        return instance.handle(args)
      })
      if (cmd.longRunning && (typeof code !== 'number' || code === 0)) this.keepAlive = true
      return typeof code === 'number' ? code : 0
    } finally {
      if (!cmd.longRunning) {
        await scope.dispose()
        await this.app.shutdown()
      }
    }
  }
}

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) (d[0] as number[])[j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const row = d[i] as number[]
      const prev = d[i - 1] as number[]
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return (d[a.length] as number[])[b.length] as number
}
