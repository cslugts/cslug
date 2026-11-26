import { timingSafeEqual } from 'node:crypto'
import { CslugError, type SessionData, type SessionStore } from '@cslug/core'

const randomId = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url')

/**
 * The session of one request: data in the `SessionStore` (memory or Redis), the id in a cookie.
 * Flash values live for the next request only.
 */
export class Session {
  /** False on the placeholder a route without the `session()` middleware gets (`MissingSession`). */
  readonly available: boolean = true
  private data: SessionData
  private dirty = false
  private destroyed: string[] = []
  /** Flash values set during the previous request (readable now). */
  private readonly previous: SessionData
  private next: SessionData = {}

  constructor(
    public id: string,
    data: SessionData,
    readonly isNew: boolean,
  ) {
    const { _flash, ...rest } = data
    this.previous = (_flash as SessionData | undefined) ?? {}
    this.data = rest
    if (Object.keys(this.previous).length) this.dirty = true // the flash must be cleared on save
  }

  static create(): Session {
    return new Session(randomId(), {}, true)
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }
  has(key: string): boolean {
    return key in this.data
  }
  put(key: string, value: unknown): void {
    this.data[key] = value
    this.dirty = true
  }
  forget(key: string): void {
    delete this.data[key]
    this.dirty = true
  }
  /** Read and remove. */
  pull<T = unknown>(key: string): T | undefined {
    const v = this.get<T>(key)
    this.forget(key)
    return v
  }

  /** A value for the next request only (`redirect().with()` uses this). */
  flash(key: string, value: unknown): void {
    this.next[key] = value
    this.dirty = true
  }
  /** Keep this request's flash values for one more request. */
  reflash(): void {
    this.next = { ...this.previous, ...this.next }
    this.dirty = true
  }
  /** Flash values from the previous request, without the internal ones (`success`, `error`, …). */
  flashed(): SessionData {
    return Object.fromEntries(Object.entries(this.previous).filter(([k]) => !k.startsWith('_')))
  }
  /** Validation errors flashed by a failed form post: `{ field: ['message'] }`. */
  errors(): Record<string, string[]> {
    return (this.previous._errors as Record<string, string[]> | undefined) ?? {}
  }
  /** The previous form input (after a failed validation), or one field of it. */
  old(): SessionData
  old(key: string): unknown
  old(key?: string): unknown {
    const old = (this.previous._old as SessionData | undefined) ?? {}
    return key === undefined ? old : old[key]
  }

  /** The CSRF token (created on first use). */
  token(): string {
    let t = this.get<string>('_token')
    if (!t) {
      t = randomId()
      this.put('_token', t)
    }
    return t
  }

  /** Constant-time comparison with the session's CSRF token. */
  verifyToken(given: string | undefined): boolean {
    const expected = this.get<string>('_token')
    if (!given || !expected) return false
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** New id, same data: call on login (prevents session fixation). */
  regenerate(): void {
    this.destroyed.push(this.id)
    this.id = randomId()
    this.dirty = true
  }

  /** Empty the session and give it a new id: call on logout. */
  invalidate(): void {
    this.data = {}
    this.next = {}
    this.regenerate()
  }

  /** Persist (only what changed) and return the ids to destroy. */
  async save(store: SessionStore, lifetime: string | number): Promise<void> {
    for (const id of this.destroyed) await store.destroy(id)
    this.destroyed = []
    if (!this.dirty && !this.isNew) return
    await store.write(
      this.id,
      Object.keys(this.next).length ? { ...this.data, _flash: this.next } : this.data,
      lifetime,
    )
  }

  /** Whether a cookie should be sent (new session with data, or a changed id). */
  get needsCookie(): boolean {
    return this.dirty || !this.isNew
  }
}

/** Placeholder until the `session()` middleware runs: every use explains how to fix it. */
export class MissingSession extends Session {
  override readonly available = false
  constructor() {
    super('', {}, true)
  }
  private fail(): never {
    throw new CslugError(
      'http.no_session',
      'This route has no session: add the session() middleware (routes in routes/web.ts have it).',
    )
  }
  override get<T>(): T | undefined {
    return this.fail()
  }
  override put(): void {
    this.fail()
  }
  override flash(): void {
    this.fail()
  }
  override token(): string {
    return this.fail()
  }
  override errors(): Record<string, string[]> {
    return {}
  }
  override old(): never {
    return this.fail()
  }
}
