import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { currentContext } from './context'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Record<string, unknown>

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** Keys whose values are never written, matched case-insensitively as substrings. */
export const DEFAULT_REDACT = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'cardnumber',
  'cvv',
]

export type LogFormat = 'json' | 'pretty'

/** Where log lines go. Each target has its own minimum level and format (default: the logger's). */
export type LogTarget = { level?: LogLevel; format?: LogFormat } & (
  | { type: 'stdout' | 'stderr' }
  | {
      type: 'file'
      /** `storage/logs/app.log`, or with `{date}` for one file per day: `storage/logs/app-{date}.log`. */
      path: string
      /** With `{date}`: how many daily files to keep (older ones are deleted when a new day starts). */
      keep?: number
    }
  | { type: 'custom'; write: (line: string, level: LogLevel) => void }
)

export type LoggerOptions = {
  /** Default: `LOG_LEVEL`, else `info`. */
  level?: LogLevel
  /** `json` (one line per entry, for production) or `pretty` (for a terminal). Default: `LOG_FORMAT`, else `json`. */
  format?: LogFormat
  /** Where lines go (default: stdout). */
  targets?: readonly LogTarget[]
  /** Extra key fragments to redact (in addition to DEFAULT_REDACT), e.g. names of secret env vars. */
  redact?: readonly string[]
  /** One custom destination instead of `targets` (tests, an MCP server writing to stderr). */
  write?: (line: string, level: LogLevel) => void
  bindings?: LogFields
}

/** Context fields copied into every entry when present (requests, jobs, traces). */
const CONTEXT_FIELDS = ['requestId', 'jobId', 'originRequestId', 'userId', 'traceId', 'spanId'] as const
const LEVEL_NAMES = new Set<string>(['debug', 'info', 'warn', 'error'])

/** A file target: appends lines; with `{date}` in the path, switches file each day and prunes old ones. */
class FileSink {
  private fd: number | undefined
  private day = ''

  constructor(private readonly target: Extract<LogTarget, { type: 'file' }>) {}

  write(line: string): void {
    const today = new Date().toISOString().slice(0, 10)
    if (this.fd === undefined || (this.target.path.includes('{date}') && today !== this.day)) this.open(today)
    writeSync(this.fd as number, `${line}\n`)
  }

  private open(today: string): void {
    if (this.fd !== undefined) closeSync(this.fd)
    this.day = today
    const path = this.target.path.replace('{date}', today)
    mkdirSync(dirname(path), { recursive: true })
    this.fd = openSync(path, 'a')
    if (this.target.path.includes('{date}') && this.target.keep) this.prune()
  }

  private prune(): void {
    const dir = dirname(this.target.path)
    const [before, after] = basename(this.target.path).split('{date}') as [string, string]
    if (!existsSync(dir)) return
    const days = readdirSync(dir)
      .filter(
        (f) =>
          f.startsWith(before) &&
          f.endsWith(after) &&
          /^\d{4}-\d{2}-\d{2}$/.test(f.slice(before.length, f.length - after.length)),
      )
      .sort()
    for (const f of days.slice(0, Math.max(0, days.length - (this.target.keep ?? days.length))))
      unlinkSync(join(dir, f))
  }
}

type Sink = { min: number; format: LogFormat; write: (line: string, level: LogLevel) => void }

/**
 * Structured logger. Every entry carries the request/job id, the request that started a job, the user and the trace
 * from the ambient context, and sensitive keys are redacted. `log.child({ area: 'admin' })` adds fields to every
 * entry. `targets` sends lines to stdout, stderr, files (one per day with `{date}`) or custom functions.
 */
export class Logger {
  private readonly min: number
  private readonly redactKeys: string[]
  private readonly sinks: Sink[]

  constructor(
    private readonly options: LoggerOptions = {},
    shared?: Sink[],
  ) {
    const envLevel = process.env.LOG_LEVEL?.toLowerCase()
    const envFormat = process.env.LOG_FORMAT?.toLowerCase()
    const level = options.level ?? (envLevel && LEVEL_NAMES.has(envLevel) ? (envLevel as LogLevel) : 'info')
    const format: LogFormat = options.format ?? (envFormat === 'pretty' ? 'pretty' : 'json')
    this.redactKeys = [...DEFAULT_REDACT, ...(options.redact ?? [])].map((k) => k.toLowerCase())
    // children share their parent's sinks (one open file, not one per child)
    this.sinks =
      shared ??
      (options.write
        ? [{ min: LEVELS[level], format, write: options.write }]
        : (options.targets ?? [{ type: 'stdout' as const }]).map((t) => {
            const write =
              t.type === 'custom'
                ? t.write
                : t.type === 'file'
                  ? (
                      (sink: FileSink) => (line: string) =>
                        sink.write(line)
                    )(new FileSink(t))
                  : t.type === 'stderr'
                    ? (line: string) => process.stderr.write(`${line}\n`)
                    : (line: string) => process.stdout.write(`${line}\n`)
            return { min: LEVELS[t.level ?? level], format: t.format ?? format, write }
          }))
    this.min = Math.min(...this.sinks.map((s) => s.min))
  }

  /** A logger that writes nothing (unit tests). */
  static null(): Logger {
    return new Logger({ write: () => {} })
  }

  child(bindings: LogFields): Logger {
    return new Logger({ ...this.options, bindings: { ...this.options.bindings, ...bindings } }, this.sinks)
  }

  isEnabled(level: LogLevel): boolean {
    return LEVELS[level] >= this.min
  }

  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields)
  }
  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields)
  }
  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields)
  }
  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields)
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (!this.isEnabled(level)) return
    const ctx = currentContext()
    const fromContext: LogFields = {}
    for (const key of CONTEXT_FIELDS) if (ctx?.[key] !== undefined) fromContext[key] = ctx[key]
    const entry = this.clean({ ...fromContext, ...this.options.bindings, ...fields }, 0, new WeakSet()) as LogFields
    const time = new Date().toISOString()
    let json: string | undefined
    let pretty: string | undefined
    for (const sink of this.sinks) {
      if (LEVELS[level] < sink.min) continue
      if (sink.format === 'pretty') {
        pretty ??= `${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${message}${Object.entries(entry)
          .map(([k, v]) => `  ${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('')}`
        sink.write(pretty, level)
      } else {
        json ??= JSON.stringify({ time, level, msg: message, ...entry })
        sink.write(json, level)
      }
    }
  }

  private redacted(key: string): boolean {
    const k = key.toLowerCase()
    return this.redactKeys.some((r) => k.includes(r))
  }

  /** JSON-safe copy: redaction, bigint → string, Date → ISO, Error → { name, message, code, stack }, cycles cut. */
  private clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Error) {
      const e = value as Error & { code?: unknown; status?: unknown }
      return {
        name: e.name,
        message: e.message,
        ...(e.code !== undefined ? { code: e.code } : {}),
        ...(e.status !== undefined ? { status: e.status } : {}),
        stack: e.stack,
        ...(e.cause !== undefined ? { cause: this.clean(e.cause, depth + 1, seen) } : {}),
      }
    }
    if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[circular]'
    if (depth >= 6) return '[…]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((v) => this.clean(v, depth + 1, seen))
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
      return this.clean((value as { toJSON: () => unknown }).toJSON(), depth + 1, seen)
    const out: LogFields = {}
    for (const [k, v] of Object.entries(value))
      out[k] = this.redacted(k) ? '[redacted]' : this.clean(v, depth + 1, seen)
    return out
  }
}
