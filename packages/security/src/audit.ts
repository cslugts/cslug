import { join } from 'node:path'
import {
  Clock,
  Command,
  type Container,
  CslugError,
  currentContext,
  DEFAULT_REDACT,
  type Duration,
  resolve,
} from '@cslug/core'

/** The `cslug_audit_log` migration (registered with @cslug/database). */
export const AUDIT_MIGRATIONS = join(import.meta.dir, '../migrations')

/** What an entry is about: `{ type: 'booking', id: booking.id }`. */
export type AuditSubject = { type: string; id: string | number | bigint }

export type AuditEntry = {
  id: string
  action: string
  userId: string | null
  subjectType: string | null
  subjectId: string | null
  ip: string | null
  requestId: string | null
  data: Record<string, unknown> | null
  createdAt: Date
}

/** Where entries go: `SecurityProvider` sets one on @cslug/database. */
export type AuditStore = {
  insert(entry: Omit<AuditEntry, 'createdAt'>): Promise<void>
  list(where: { subject?: AuditSubject; userId?: string }, limit: number): Promise<AuditEntry[]>
  prune(before: Date): Promise<number>
}

const redacted = (key: string) => DEFAULT_REDACT.some((r) => key.toLowerCase().includes(r))

/** A JSON-safe copy with secret-looking keys redacted (as in logs). */
function clean(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return value
  if (depth > 8) return '[deep]'
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = redacted(k) ? '[redacted]' : clean(v, depth + 1)
  return out
}

/**
 * The audit log: who did what, when, from where. `record()` takes the user, IP and request id from the context,
 * and writes in the current transaction (a rolled-back change leaves no entry).
 */
export class Audit {
  store?: AuditStore

  constructor(
    private readonly container: Container,
    readonly keep: Duration = '365d',
  ) {}

  private get db(): AuditStore {
    if (!this.store) throw new CslugError('security.audit_needs_database', 'The audit log needs @cslug/database')
    return this.store
  }

  async record(
    action: string,
    options: { subject?: AuditSubject; data?: Record<string, unknown>; userId?: string | null } = {},
  ): Promise<void> {
    const ctx = currentContext()
    const http = ctx?.http as { request?: { ip(): string | undefined } } | undefined
    const userId = options.userId === undefined ? (ctx?.userId as string | undefined) : options.userId
    await this.db.insert({
      id: Bun.randomUUIDv7(),
      action,
      userId: userId == null ? null : String(userId),
      subjectType: options.subject?.type ?? null,
      subjectId: options.subject ? String(options.subject.id) : null,
      ip: http?.request?.ip() ?? null,
      requestId: (ctx?.requestId as string | undefined) ?? null,
      data: options.data ? (clean(options.data) as Record<string, unknown>) : null,
    })
  }

  /** Entries about a subject, newest first. */
  for(subject: AuditSubject, options: { limit?: number } = {}): Promise<AuditEntry[]> {
    return this.db.list({ subject }, options.limit ?? 100)
  }

  /** Entries by a user, newest first. */
  byUser(userId: string, options: { limit?: number } = {}): Promise<AuditEntry[]> {
    return this.db.list({ userId: String(userId) }, options.limit ?? 100)
  }

  /** Delete entries older than `olderThan` (default: `security.audit.keep`, 365 days). Returns how many. */
  prune(olderThan: Duration = this.keep): Promise<number> {
    return this.db.prune(this.container.resolve(Clock).subtract(olderThan))
  }
}

/** `cslug audit:prune`: delete audit entries older than `security.audit.keep`. Schedule it daily. */
export class AuditPruneCommand extends Command {
  static signature = 'audit:prune'
  static description = 'Delete audit log entries older than security.audit.keep'

  async handle() {
    const audit = resolve(Audit)
    const deleted = await audit.prune()
    this.success(`Deleted ${deleted} audit entr${deleted === 1 ? 'y' : 'ies'} older than ${audit.keep}`)
    return 0
  }
}
