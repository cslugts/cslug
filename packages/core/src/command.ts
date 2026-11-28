import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Clock } from './clock'
import { currentApp, resolve } from './context'
import { CslugError } from './errors'
import { Logger } from './logger'

// ── arguments and flags ──────────────────────────────────────────────────────────────────────────────
type Kind = 'string' | 'number' | 'date' | 'boolean' | 'list'

/** One argument or flag of a command. Immutable: every modifier returns a copy. */
export class ArgSpec<T = unknown> {
  declare readonly _type: T
  constructor(
    readonly kind: Kind,
    readonly positional: boolean,
    readonly opts: {
      optional?: boolean
      fallback?: unknown
      description?: string
      alias?: string
      choices?: readonly string[]
    } = {},
  ) {}
  private with<U>(patch: ArgSpec['opts']): ArgSpec<U> {
    return new ArgSpec<U>(this.kind, this.positional, { ...this.opts, ...patch })
  }
  optional(): ArgSpec<T | undefined> {
    return this.with({ optional: true })
  }
  default(value: Exclude<T, undefined>): ArgSpec<Exclude<T, undefined>> {
    return this.with({ optional: true, fallback: value })
  }
  describe(description: string): this {
    return this.with({ description }) as this
  }
  /** One-letter alias for a flag: `-f`. */
  alias(letter: string): this {
    return this.with({ alias: letter }) as this
  }
  /** Allowed values (strings). */
  choices<const C extends string>(...choices: C[]): ArgSpec<C | Extract<T, undefined>> {
    return this.with({ choices })
  }
}

/** Positional arguments, in declaration order: `cslug make:controller Claim`. */
export const arg = {
  string: () => new ArgSpec<string>('string', true),
  number: () => new ArgSpec<number>('number', true),
  /** `YYYY-MM-DD`. */
  date: () => new ArgSpec<string>('date', true),
}
/** Options: `--dry-run`, `--queues=default,mail`, `-f`. A camelCase key is written in kebab-case. */
export const flag = {
  boolean: () => new ArgSpec<boolean>('boolean', false, { optional: true, fallback: false }),
  string: () => new ArgSpec<string>('string', false),
  number: () => new ArgSpec<number>('number', false),
  date: () => new ArgSpec<string>('date', false),
  /** Repeatable or comma-separated. */
  list: () => new ArgSpec<string[]>('list', false, { optional: true, fallback: [] }),
}

export type ArgsSpec = Record<string, ArgSpec>

export class UsageError extends CslugError {
  constructor(message: string) {
    super('cli.usage', message)
  }
}

export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function convert(name: string, spec: ArgSpec, raw: string): unknown {
  if (spec.opts.choices && !spec.opts.choices.includes(raw)) {
    throw new UsageError(`${name} must be one of: ${spec.opts.choices.join(', ')} (got "${raw}")`)
  }
  if (spec.kind === 'number') {
    const n = Number(raw)
    if (raw === '' || Number.isNaN(n)) throw new UsageError(`${name} must be a number (got "${raw}")`)
    return n
  }
  if (spec.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw))
    throw new UsageError(`${name} must be a date YYYY-MM-DD (got "${raw}")`)
  return raw
}

/** Parse argv against a command's spec. Unknown flags and missing arguments are usage errors. */
export function parseArgs(spec: ArgsSpec, argv: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const entries = Object.entries(spec)
  const positional = entries.filter(([, s]) => s.positional)
  const byFlag = new Map<string, [string, ArgSpec]>()
  for (const [k, s] of entries.filter(([, s]) => !s.positional)) {
    byFlag.set(kebab(k), [k, s])
    if (s.opts.alias) byFlag.set(s.opts.alias, [k, s])
  }
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '--') {
      values.push(...argv.slice(i + 1))
      break
    }
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(token)
    if (!m || /^-\d/.test(token)) {
      values.push(token)
      continue
    }
    let name = m[1] as string
    const negated = name.startsWith('no-') && !byFlag.has(name)
    if (negated) name = name.slice(3)
    const found = byFlag.get(name)
    if (!found) throw new UsageError(`Unknown option --${name}`)
    const [key, s] = found
    if (s.kind === 'boolean') {
      out[key] = negated ? false : m[2] === undefined ? true : !['false', '0', 'no'].includes(m[2])
      continue
    }
    const raw = m[2] ?? argv[++i]
    if (raw === undefined) throw new UsageError(`--${name} needs a value`)
    if (s.kind === 'list') out[key] = [...((out[key] as string[] | undefined) ?? []), ...raw.split(',').filter(Boolean)]
    else out[key] = convert(`--${name}`, s, raw)
  }
  if (values.length > positional.length) throw new UsageError(`Unexpected argument "${values[positional.length]}"`)
  positional.forEach(([k, s], i) => {
    if (values[i] !== undefined) out[k] = convert(`<${kebab(k)}>`, s, values[i] as string)
  })
  for (const [k, s] of entries) {
    if (out[k] !== undefined) continue
    if (s.opts.fallback !== undefined) out[k] = s.opts.fallback
    else if (!s.opts.optional)
      throw new UsageError(s.positional ? `Missing argument <${kebab(k)}>` : `Missing option --${kebab(k)}`)
  }
  return out
}

// ── output ───────────────────────────────────────────────────────────────────────────────────────────
/** Where commands write and read. Tests swap it for `BufferedIO`. */
export class ConsoleIO {
  readonly color = !!process.stdout.isTTY && !process.env.NO_COLOR
  readonly interactive = !!process.stdin.isTTY
  write(text: string): void {
    process.stdout.write(text)
  }
  error(text: string): void {
    process.stderr.write(text)
  }
  async ask(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }
}

const paint = (on: boolean, code: number, s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s)

// ── the command ──────────────────────────────────────────────────────────────────────────────────────
/** A command class: `static signature`, `description`, `args`, and a `handle(args)` method. */
export type CommandClass = (abstract new (
  ...args: never[]
) => Command) & {
  readonly signature: string
  readonly description?: string
  readonly args?: ArgsSpec
  /** `false`: run without booting the providers (generators, `key:generate`): no database connection needed. */
  readonly boot?: boolean
  /** Long-running (`serve`, `queue:work`): the CLI waits for a signal instead of shutting the app down after `handle()`. */
  readonly longRunning?: boolean
}

/**
 * Base class of `cslug` commands. Declare `static signature`, `description`, `args`, write `handle(args)`;
 * return a number to set the exit code. `handle` is not declared here, so no `override` is needed.
 */
export abstract class Command {
  /** The parsed arguments of `C`: `handle(args: Command.Args<typeof MyCommand>)`. */
  declare static readonly __args: never

  get app() {
    return currentApp()
  }
  get clock(): Clock {
    return resolve(Clock)
  }
  get log(): Logger {
    return resolve(Logger)
  }
  get io(): ConsoleIO {
    return resolve(ConsoleIO)
  }

  line(text = ''): void {
    this.io.write(`${text}\n`)
  }
  info(text: string): void {
    this.line(paint(this.io.color, 36, text))
  }
  success(text: string): void {
    this.line(paint(this.io.color, 32, `✓ ${text}`))
  }
  warn(text: string): void {
    this.line(paint(this.io.color, 33, `! ${text}`))
  }
  error(text: string): void {
    this.io.error(`${paint(this.io.color, 31, `✗ ${text}`)}\n`)
  }

  /** Rows as an aligned table (columns from the first row's keys). */
  table(rows: readonly Record<string, unknown>[]): void {
    if (!rows.length) {
      this.line('(none)')
      return
    }
    const keys = Object.keys(rows[0] as object)
    const cell = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v))
    const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => cell(r[k]).length)))
    const fmt = (cells: string[]) =>
      cells
        .map((c, i) => c.padEnd(widths[i] as number))
        .join('  ')
        .trimEnd()
    this.line(paint(this.io.color, 1, fmt(keys)))
    for (const r of rows) this.line(fmt(keys.map((k) => cell(r[k]))))
  }

  /** Yes/no. Not interactive (CI, pipes) → `fallback`. */
  async confirm(question: string, fallback = false): Promise<boolean> {
    if (!this.io.interactive) return fallback
    const answer = (await this.io.ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
    return answer === '' ? fallback : ['y', 'yes', 'o', 'oui'].includes(answer)
  }
  async ask(question: string, fallback = ''): Promise<string> {
    if (!this.io.interactive) return fallback
    return (await this.io.ask(`${question}${fallback ? ` (${fallback})` : ''}: `)).trim() || fallback
  }
  async choose<const C extends string>(question: string, choices: readonly C[], fallback?: C): Promise<C> {
    if (!this.io.interactive) return fallback ?? (choices[0] as C)
    choices.forEach((c, i) => {
      this.line(`  ${i + 1}. ${c}`)
    })
    const answer = (await this.io.ask(`${question}: `)).trim()
    return choices[Number(answer) - 1] ?? choices.find((c) => c === answer) ?? fallback ?? (choices[0] as C)
  }
  /** A counter on one line: `const p = this.progress(n); … p.tick(); p.done()`. */
  progress(total: number) {
    let n = 0
    const draw = () => {
      if (this.io.color) this.io.write(`\r${n}/${total}`)
    }
    return {
      tick: (by = 1) => {
        n += by
        draw()
      },
      done: () => {
        if (this.io.color) this.io.write('\n')
      },
    }
  }

  /**
   * Write a file from a stub (`{{ name }}` placeholders). The app's `stubs/<stub>` wins over the package's.
   * Never overwrites unless `force`; prints what it wrote. Returns false if the file existed.
   */
  protected generate(
    stubDir: string,
    stub: string,
    target: string,
    vars: Record<string, string>,
    force = false,
  ): boolean {
    const root = this.app.rootDir
    const own = join(root, 'stubs', stub)
    const template = readFileSync(existsSync(own) ? own : join(stubDir, stub), 'utf8')
    const path = join(root, target)
    if (existsSync(path) && !force) {
      this.warn(`${relative(root, path)} exists (use --force to overwrite)`)
      return false
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? ''),
    )
    this.success(`created ${relative(root, path)}`)
    return true
  }
}

export declare namespace Command {
  /** The parsed arguments of a command class. */
  type Args<C extends { args?: ArgsSpec }> = { [K in keyof NonNullable<C['args']>]: NonNullable<C['args']>[K]['_type'] }
}

/**
 * Names for a generator from user input: `admin/Claim` + suffix `controller` →
 * `{ dir: 'admin', base: 'Claim', class: 'ClaimController', file: 'admin/claim-controller', kebab: 'claim', snake: 'claim', camel: 'claim' }`.
 */
export function names(input: string, suffix = '') {
  const parts = input.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = parts.pop() ?? ''
  const dir = parts.map((p) => toKebab(p)).join('/')
  const suffixPascal = toPascal(suffix)
  let base = toPascal(last)
  if (suffixPascal && base.endsWith(suffixPascal) && base !== suffixPascal) base = base.slice(0, -suffixPascal.length)
  const kebabBase = toKebab(base)
  const fileName = suffix ? `${kebabBase}-${toKebab(suffix)}` : kebabBase
  return {
    dir,
    base,
    class: `${base}${suffixPascal}`,
    file: dir ? `${dir}/${fileName}` : fileName,
    kebab: kebabBase,
    snake: kebabBase.replace(/-/g, '_'),
    camel: base.charAt(0).toLowerCase() + base.slice(1),
  }
}
const toKebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
const toPascal = (s: string) =>
  s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')

/** Tag of the command classes contributed by providers (`this.commands([...])`). */
export const COMMANDS = 'cslug.commands'

/** Tag of the `cslug describe` sections contributed by providers (`this.describe('routes', () => …)`). */
export const DESCRIBE = 'cslug.describe'

/** One section of `cslug describe`: JSON-ready data about the app (routes, tables, jobs…). */
export type DescribeSection = { name: string; collect: () => unknown }

export type Names = ReturnType<typeof names>

/** One file a generator writes: `stub` from the package's stubs folder (or the app's `stubs/`), to `target`. */
export type GeneratedFile = { stub: string; target: string }

/**
 * A `make:<kind> Name` command for a package: `files(n)` says what to write, from `n` (the name's parts with
 * `suffix`: `names(name, suffix)`); every `{{ var }}` of the stubs is filled from `n` and `vars(n)`. The app's
 * `stubs/<stub>` wins over the package's. Never overwrites without `--force`; needs no booted app.
 *
 * ```ts
 * defineGenerator({ kind: 'job', description: 'Create a job', stubs: STUBS,
 *   files: (n) => [{ stub: 'job.stub', target: `app/jobs/${n.file}.ts` }] })
 * ```
 */
export function defineGenerator(options: {
  kind: string
  description: string
  stubs: string
  /** The class name suffix (`job` → `SendCheckinJob`, `send-checkin-job.ts`); default `kind`, `''` for none. */
  suffix?: string
  files: (n: Names) => GeneratedFile[]
  vars?: (n: Names) => Record<string, string>
}): CommandClass {
  const args = { name: arg.string().describe('e.g. Claim, or admin/Claim'), force: flag.boolean() }
  return class extends Command {
    static signature = `make:${options.kind}`
    static description = options.description
    static boot = false
    static args = args
    handle({ name, force }: Command.Args<{ args: typeof args }>) {
      const n = names(name, options.suffix ?? options.kind)
      const vars = { ...n, ...options.vars?.(n) }
      let ok = true
      for (const file of options.files(n)) ok = this.generate(options.stubs, file.stub, file.target, vars, force) && ok
      return ok ? 0 : 1
    }
  }
}
