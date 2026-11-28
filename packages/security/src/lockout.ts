import { AppError, Cache, Clock, type Container, type Duration, Event } from '@cslug/core'

/** An account was locked after too many failed passwords. Listen to it to tell the user. */
export class AccountLocked extends Event<{ email: string; userId?: string; ip: string | undefined; until: Date }>(
  'security.account_locked',
) {}

/** 423: the account is locked until `until` (`retryAfter` in seconds). */
export class AccountLockedError extends AppError {
  constructor(readonly until: Date) {
    super('security.account_locked', 'This account is locked after too many failed attempts. Try again later.', {
      status: 423,
      params: { retryAfter: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)) },
    })
  }
}

export type LockoutOptions = {
  /** Failed passwords before the account locks (default 5). */
  attempts?: number
  /** How long failures are counted, and how long the lock lasts (default `'15m'`). */
  decay?: Duration
}

const normal = (email: string) => email.trim().toLowerCase()

/**
 * Account lockout, per email (not per IP: it stops a slow guess spread over many addresses). Failures are counted in
 * the `Cache` (shared through @cslug/redis). With @cslug/auth, `SecurityProvider` wires it to the login events.
 */
export class Lockout {
  constructor(
    private readonly container: Container,
    readonly options: LockoutOptions = {},
  ) {}

  // resolved on each use, so a swapped Cache or Clock (tests) is the one used
  private get cache() {
    return this.container.resolve(Cache)
  }
  private get clock() {
    return this.container.resolve(Clock)
  }

  private get decay(): Duration {
    return this.options.decay ?? '15m'
  }

  /** When the account's lock ends, or undefined if it is not locked. */
  async lockedUntil(email: string): Promise<Date | undefined> {
    const until = await this.cache.get<string>(`security:locked:${normal(email)}`)
    return until ? new Date(until) : undefined
  }

  /** Throw `AccountLockedError` if the account is locked. */
  async assertUnlocked(email: string): Promise<void> {
    const until = await this.lockedUntil(email)
    if (until) throw new AccountLockedError(until)
  }

  /** Count a failed password; locks the account (and emits `AccountLocked`) at the limit. True when it locked. */
  async failed(email: string, info: { userId?: string; ip?: string } = {}): Promise<boolean> {
    const key = normal(email)
    const count = await this.cache.increment(`security:failures:${key}`, 1, this.decay)
    if (count < (this.options.attempts ?? 5) || (await this.lockedUntil(key))) return false
    const until = this.clock.add(this.decay)
    await this.cache.set(`security:locked:${key}`, until.toISOString(), this.decay)
    await this.cache.forget(`security:failures:${key}`)
    await AccountLocked.emit({ email: key, ...(info.userId ? { userId: info.userId } : {}), ip: info.ip, until })
    return true
  }

  /** Forget the failures (after a successful login). */
  async succeeded(email: string): Promise<void> {
    await this.cache.forget(`security:failures:${normal(email)}`)
  }

  /** Unlock an account now (support, an admin screen). */
  async unlock(email: string): Promise<void> {
    await this.cache.forget(`security:locked:${normal(email)}`)
    await this.cache.forget(`security:failures:${normal(email)}`)
  }
}
