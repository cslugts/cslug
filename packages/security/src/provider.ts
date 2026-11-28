import {
  type Application,
  Clock,
  currentContext,
  type Duration,
  EventBus,
  type EventClass,
  Logger,
  type RateLimit,
  ServiceProvider,
} from '@cslug/core'
import { HttpKernel, Router } from '@cslug/http'
import { AUDIT_MIGRATIONS, Audit, type AuditEntry, AuditPruneCommand, type AuditStore } from './audit'
import { type CspOptions, csp } from './csp'
import { type IpFilterOptions, ipFilter } from './ip'
import { ipLimit } from './limit'
import { AccountLocked, Lockout, type LockoutOptions } from './lockout'
import { type SecurityTxtOptions, securityTxt } from './security-txt'

export type SecurityConfig = {
  /** A Content-Security-Policy with a per-request nonce on every response (default: on); false: off. */
  csp?: CspOptions | false
  /** One rate limit over every request from an IP (`'600/min'`); health checks are not counted. Default: off. */
  limit?: RateLimit | false
  /** Allow or deny addresses and CIDR ranges for the whole app. */
  ipFilter?: IpFilterOptions
  /** Serve `/.well-known/security.txt`. */
  securityTxt?: SecurityTxtOptions | false
  /** Lock an account after repeated failed passwords (with @cslug/auth). Default: off. */
  lockout?: LockoutOptions | false
  /**
   * The audit log (with @cslug/database). `keep`: how long `audit:prune` keeps entries (default `'365d'`);
   * `auth: false` stops recording auth events.
   */
  audit?: { keep?: Duration; auth?: boolean } | false
}

/** A login event's payload, as far as this package reads it. */
type AuthPayload = { email?: string; userId?: string; ip?: string; reason?: string; tokenId?: string } & Record<
  string,
  unknown
>
type AuthEvent = EventClass<AuthPayload> & { readonly eventName: string }
/**
 * @cslug/auth's events, loaded at runtime with a local type: importing its types would load a second copy of its
 * `HttpContext` augmentation when the workspace is reachable through two paths (as in @cslug/testing).
 */
type AuthEvents = Record<
  | 'LoginAttempting'
  | 'LoginFailed'
  | 'LoginSucceeded'
  | 'LoggedOut'
  | 'TwoFactorEnabled'
  | 'TwoFactorDisabled'
  | 'RecoveryCodesRegenerated'
  | 'TokenCreated'
  | 'TokenRevoked',
  AuthEvent
>
const importOptional = <M>(name: string): Promise<M> => import(name)

/** Rows in the ambient transaction, through @cslug/database. */
async function databaseStore(app: Application): Promise<AuditStore | undefined> {
  const db = await import('@cslug/database').catch(() => undefined)
  if (!db || !app.has(db.Database)) return undefined
  db.addMigrations(AUDIT_MIGRATIONS)
  const { sql } = db
  const database = () => app.resolve(db.Database)
  return {
    insert: async (e) => {
      await database().exec(sql`insert into cslug_audit_log
        (id, action, user_id, subject_type, subject_id, ip, request_id, data)
        values (${e.id}, ${e.action}, ${e.userId}, ${e.subjectType}, ${e.subjectId}, ${e.ip}, ${e.requestId},
          ${e.data === null ? null : sql.json(e.data)})`)
    },
    list: (where, limit) =>
      database().many<AuditEntry>(
        sql`select * from cslug_audit_log where ${
          where.subject
            ? sql`subject_type = ${where.subject.type} and subject_id = ${String(where.subject.id)}`
            : sql`user_id = ${where.userId ?? null}`
        } order by created_at desc, id desc limit ${limit}`,
      ),
    prune: (before) => database().exec(sql`delete from cslug_audit_log where created_at < ${before}`),
  }
}

/**
 * From `config/security.ts`: global middleware (IP filter, then the per-IP limit, then CSP),
 * `/.well-known/security.txt`, account lockout on @cslug/auth's login events, and the audit log on
 * @cslug/database (auth events recorded). List it after `HttpProvider`.
 */
export class SecurityProvider extends ServiceProvider {
  private config(): SecurityConfig {
    return this.app.config<SecurityConfig | undefined>('security') ?? {}
  }

  register() {
    const { lockout, audit } = this.config()
    this.app.singleton(Lockout, () => new Lockout(this.app, lockout || {}))
    this.app.singleton(Audit, () => new Audit(this.app, audit ? audit.keep : undefined))
    this.commands([AuditPruneCommand])
  }

  async boot() {
    const config = this.config()
    const kernel = this.app.resolve(HttpKernel)
    if (config.ipFilter?.allow || config.ipFilter?.deny) kernel.global.push(ipFilter(config.ipFilter))
    if (config.limit) kernel.global.push(ipLimit(config.limit))
    if (config.csp !== false) kernel.global.push(csp(config.csp ?? {}))
    if (config.securityTxt) this.securityTxtRoute(config.securityTxt)

    const audit = this.app.resolve(Audit)
    if (config.audit !== false) audit.store = await databaseStore(this.app)
    const authEvents = await importOptional<AuthEvents>('@cslug/auth').catch(() => undefined)
    if (!authEvents) return
    if (config.lockout) this.lockout(authEvents)
    if (audit.store && config.audit !== false && config.audit?.auth !== false) this.recordAuth(authEvents, audit)
  }

  /** Refuse a locked account before its password is checked; count failed passwords; reset after a login. */
  private lockout(a: AuthEvents) {
    const bus = this.app.resolve(EventBus)
    const lockout = this.app.resolve(Lockout)
    // the email of this request's login attempt, to reset its failures when it succeeds
    const attempts = new WeakMap<object, string>()
    bus.on(a.LoginAttempting, async ({ email }) => {
      if (!email) return
      await lockout.assertUnlocked(email)
      const ctx = currentContext()
      if (ctx) attempts.set(ctx, email)
    })
    bus.on(a.LoginFailed, async ({ reason, email, userId, ip }) => {
      if (reason === 'credentials' && email) await lockout.failed(email, { userId, ip })
    })
    bus.on(a.LoginSucceeded, async () => {
      const ctx = currentContext()
      const email = ctx && attempts.get(ctx)
      if (email) await lockout.succeeded(email)
    })
  }

  /** Each auth event becomes an entry (action: the event's name); a failure to record is logged, not thrown. */
  private recordAuth(a: AuthEvents, audit: Audit) {
    const bus = this.app.resolve(EventBus)
    const log = this.app.resolve(Logger)
    const events: AuthEvent[] = [
      a.LoginSucceeded,
      a.LoginFailed,
      a.LoggedOut,
      a.TwoFactorEnabled,
      a.TwoFactorDisabled,
      a.RecoveryCodesRegenerated,
      a.TokenCreated,
      a.TokenRevoked,
      AccountLocked as unknown as AuthEvent,
    ]
    for (const event of events) {
      const action = event.eventName
      bus.on(event, async (payload) => {
        const { userId, ip: _ip, tokenId, ...data } = payload
        try {
          await audit.record(action, {
            ...(userId !== undefined ? { userId: userId ?? null } : {}),
            ...(tokenId ? { subject: { type: 'access_token', id: tokenId } } : {}),
            ...(Object.keys(data).length ? { data } : {}),
          })
        } catch (error) {
          log.error('security.audit_failed', { action, error })
        }
      })
    }
  }

  private securityTxtRoute(options: SecurityTxtOptions) {
    const url = this.app.config<string | undefined>('app.url')
    const body = securityTxt(options, {
      expires: this.app.resolve(Clock).add('365d'),
      canonical: url ? new URL('/.well-known/security.txt', url).toString() : undefined,
    })
    this.app.resolve(Router).load((r) => {
      r.get(
        '/.well-known/security.txt',
        () => new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      ).name('security.txt')
    })
  }
}
