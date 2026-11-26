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

export type LoggerOptions = {
  level?: LogLevel
  /** `json` (one line per entry, for production) or `pretty` (for a terminal). */
  format?: 'json' | 'pretty'
  /** Extra key fragments to redact (in addition to DEFAULT_REDACT), e.g. names of secret env vars. */
  redact?: readonly string[]
  /** Where lines go. Default: stdout. */
  write?: (line: string, level: LogLevel) => void
  bindings?: LogFields
}

/**
 * Structured logger. Every entry carries the request/job id and user from the ambient context, and sensitive
 * keys are redacted. `log.child({ area: 'admin' })` adds fields to every entry.
 */
export class Logger {
  private readonly min: number
  private readonly redactKeys: string[]
  private readonly write: (line: string, level: LogLevel) => void

  constructor(private readonly options: LoggerOptions = {}) {
    this.min = LEVELS[options.level ?? 'info']
    this.redactKeys = [...DEFAULT_REDACT, ...(options.redact ?? [])].map((k) => k.toLowerCase())
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`))
  }

  /** A logger that writes nothing (unit tests). */
  static null(): Logger {
    return new Logger({ write: () => {} })
  }

  child(bindings: LogFields): Logger {
    return new Logger({ ...this.options, bindings: { ...this.options.bindings, ...bindings } })
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
    for (const key of ['requestId', 'jobId', 'userId'] as const)
      if (ctx?.[key] !== undefined) fromContext[key] = ctx[key]
    const entry = this.clean({ ...fromContext, ...this.options.bindings, ...fields }, 0, new WeakSet()) as LogFields
    if (this.options.format === 'pretty') {
      const extra = Object.entries(entry)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
      this.write(
        `${new Date().toISOString().slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${message}${extra ? `  ${extra}` : ''}`,
        level,
      )
      return
    }
    this.write(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...entry }), level)
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
