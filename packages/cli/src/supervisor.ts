import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS, Command, type CommandClass, flag } from '@cslug/core'
import type { CslugConfig } from './config'

/** One child process: its role label and the `cslug` arguments it runs. */
export type ProcessSpec = { name: string; argv: string[] }

const BIN = join(import.meta.dir, 'bin.ts')

/**
 * The processes `cslug start` runs, from flags (when given) or `cslug.config.ts`. Roles whose command is not
 * installed (worker without @cslug/queue) are skipped with a warning by the caller.
 */
export function plannedProcesses(
  config: CslugConfig['processes'] = {},
  flags: { web?: boolean; worker?: string[]; scheduler?: boolean } = {},
): ProcessSpec[] {
  const explicit = flags.web || flags.scheduler || (flags.worker?.length ?? 0) > 0
  const web = explicit ? (flags.web ? { instances: 1 } : false) : (config.web ?? { instances: 1 })
  const workers = explicit
    ? (flags.worker ?? []).flatMap(parseWorker)
    : config.worker === false
      ? []
      : (config.worker ?? [{ queues: ['default'] }])
  const scheduler = explicit ? !!flags.scheduler : (config.scheduler ?? true)

  const out: ProcessSpec[] = []
  const instances = web ? (web.instances ?? 1) : 0
  for (let i = 1; i <= instances; i++)
    out.push({ name: instances > 1 ? `web#${i}` : 'web', argv: ['serve', ...(instances > 1 ? ['--reuse-port'] : [])] })
  workers.forEach((w, i) => {
    out.push({
      name: workers.length > 1 ? `worker#${i + 1}` : 'worker',
      argv: [
        'queue:work',
        ...(w.queues?.length ? [`--queues=${w.queues.join(',')}`] : []),
        ...(w.concurrency ? [`--concurrency=${w.concurrency}`] : []),
      ],
    })
  })
  if (scheduler) out.push({ name: 'scheduler', argv: ['schedule:work'] })
  return out
}

/** `--worker=2` → two default workers; `--worker=payments:1` → queues payments, concurrency 1. */
function parseWorker(spec: string): { queues?: string[]; concurrency?: number }[] {
  if (/^\d+$/.test(spec)) return Array.from({ length: Number(spec) }, () => ({ queues: ['default'] }))
  const [queues, concurrency] = spec.split(':')
  return [
    {
      queues: (queues ?? 'default').split(',').filter(Boolean),
      concurrency: concurrency ? Number(concurrency) : undefined,
    },
  ]
}

type Child = { spec: ProcessSpec; proc?: Bun.Subprocess; startedAt: number; restarts: number; exited?: number | null }

/**
 * Runs each role as a child process, restarts crashed ones with backoff (1s, 2s, 4s … 30s; reset after a minute
 * up), forwards SIGTERM/SIGINT, waits for them to drain (then kills what is left), and resolves with the exit code.
 */
export class Supervisor {
  private readonly children: Child[]
  private stopping = false
  private done!: (code: number) => void
  readonly finished = new Promise<number>((r) => {
    this.done = r
  })

  constructor(
    specs: ProcessSpec[],
    private readonly options: {
      cwd: string
      /** Extra `bun` flags (`--watch` for `cslug dev`). */
      bunFlags?: string[]
      /** Seconds a child gets after SIGTERM (default 30). */
      shutdownTimeout?: number
      log?: (line: string) => void
      /** Prefix child output with its role (default: when stdout is a terminal; plain JSON lines otherwise). */
      prefix?: boolean
      bin?: string
    },
  ) {
    this.children = specs.map((spec) => ({ spec, startedAt: 0, restarts: 0 }))
  }

  private get log() {
    return this.options.log ?? ((l: string) => process.stdout.write(`${l}\n`))
  }

  start(): this {
    for (const c of this.children) this.spawn(c)
    return this
  }

  get pids(): Record<string, number | undefined> {
    return Object.fromEntries(this.children.map((c) => [c.spec.name, c.proc?.pid]))
  }

  private spawn(child: Child): void {
    const prefix = this.options.prefix ?? !!process.stdout.isTTY
    child.startedAt = Date.now()
    child.exited = undefined
    const proc = Bun.spawn(
      [process.execPath, ...(this.options.bunFlags ?? []), this.options.bin ?? BIN, ...child.spec.argv],
      {
        cwd: this.options.cwd,
        env: { ...process.env, CSLUG_ROLE: child.spec.name },
        stdout: prefix ? 'pipe' : 'inherit',
        stderr: prefix ? 'pipe' : 'inherit',
        stdin: 'ignore',
      },
    )
    child.proc = proc
    if (prefix) {
      this.pipe(proc.stdout as ReadableStream<Uint8Array>, child.spec.name, process.stdout)
      this.pipe(proc.stderr as ReadableStream<Uint8Array>, child.spec.name, process.stderr)
    }
    this.log(`  ➜ ${child.spec.name.padEnd(10)} pid ${proc.pid}  cslug ${child.spec.argv.join(' ')}`)
    proc.exited.then((code) => this.onExit(child, proc, code))
  }

  private async pipe(stream: ReadableStream<Uint8Array>, name: string, out: NodeJS.WriteStream): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) out.write(`[${name}] ${line}\n`)
    }
    if (buffer) out.write(`[${name}] ${buffer}\n`)
  }

  private onExit(child: Child, proc: Bun.Subprocess, code: number | null): void {
    if (child.proc !== proc) return
    child.exited = code
    if (this.stopping) {
      if (this.children.every((c) => c.exited !== undefined))
        this.done(this.children.every((c) => c.exited === 0) ? 0 : 1)
      return
    }
    // a child that stayed up for a minute starts over with a short delay
    if (Date.now() - child.startedAt > 60_000) child.restarts = 0
    const delay = Math.min(30_000, 1000 * 2 ** child.restarts++)
    this.log(`  ✗ ${child.spec.name} exited (${code ?? 'signal'}); restarting in ${delay / 1000}s`)
    setTimeout(() => {
      if (!this.stopping) this.spawn(child)
    }, delay)
  }

  /** Forward SIGTERM to every child; kill the ones still running after the timeout. */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<number> {
    if (this.stopping) return this.finished
    this.stopping = true
    const running = this.children.filter((c) => c.proc && c.exited === undefined)
    for (const c of this.children) if (!running.includes(c)) c.exited = 0 // crashed and waiting to restart: nothing to stop
    if (!running.length) this.done(0)
    for (const c of running) c.proc?.kill(signal)
    const timeout = (this.options.shutdownTimeout ?? 30) * 1000
    const timer = setTimeout(() => {
      for (const c of running) if (c.exited === undefined) c.proc?.kill('SIGKILL')
    }, timeout)
    const code = await this.finished
    clearTimeout(timer)
    return code
  }
}

const commandExists = async (app: Command['app'], signature: string): Promise<boolean> => {
  const { builtinCommands } = await import('./commands/builtin')
  return [...builtinCommands, ...(app.taggedTokens(COMMANDS) as CommandClass[])].some((c) => c.signature === signature)
}

async function loadConfig(root: string): Promise<CslugConfig> {
  const path = join(root, 'cslug.config.ts')
  return existsSync(path) ? (((await import(path)).default as CslugConfig | undefined) ?? {}) : {}
}

const roleFlags = {
  web: flag.boolean().describe('Run the web server'),
  worker: flag.list().describe('Workers: 2 | payments:1 | default,mail:5 (repeatable)'),
  scheduler: flag.boolean().describe('Run the scheduler'),
}

async function supervise(
  cmd: Command,
  flags: Command.Args<{ args: typeof roleFlags }>,
  bunFlags: string[],
  banner: string,
): Promise<number> {
  const config = await loadConfig(cmd.app.rootDir)
  const planned = plannedProcesses(config.processes, flags)
  const specs: ProcessSpec[] = []
  for (const p of planned) {
    if (await commandExists(cmd.app, p.argv[0] as string)) specs.push(p)
    else
      cmd.warn(
        `${p.name}: \`cslug ${p.argv[0]}\` is not installed (${p.argv[0] === 'serve' ? '@cslug/http' : '@cslug/queue'}); skipped`,
      )
  }
  if (!specs.length) {
    cmd.error('Nothing to run')
    return 1
  }
  cmd.line(`  cslug  ${banner}  (supervisor pid ${process.pid})`)
  const supervisor = new Supervisor(specs, {
    cwd: cmd.app.rootDir,
    bunFlags,
    shutdownTimeout: config.shutdownTimeout,
    log: (l) => cmd.line(l),
  }).start()
  const onSignal = (signal: NodeJS.Signals) => {
    cmd.line(`  ${signal}: stopping ${specs.length} process(es)…`)
    supervisor.stop(signal).then((code) => process.exit(code))
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  return 0
}

/** `cslug start`: production supervisor. */
export class StartCommand extends Command {
  static signature = 'start'
  static description = 'Run web, workers and scheduler as supervised child processes (cslug.config.ts processes)'
  static boot = false
  static longRunning = true
  static args = roleFlags

  handle(flags: Command.Args<typeof StartCommand>) {
    return supervise(this, flags, [], 'start')
  }
}

/** `cslug dev`: the same processes, restarted by `bun --watch` when a file changes. */
export class DevCommand extends Command {
  static signature = 'dev'
  static description = 'Development: web, workers and scheduler, restarted when files change'
  static boot = false
  static longRunning = true
  static args = roleFlags

  handle(flags: Command.Args<typeof DevCommand>) {
    return supervise(this, flags, ['--watch', '--no-clear-screen'], 'dev')
  }
}
