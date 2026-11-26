import { expect } from 'bun:test'
import type { Application } from '@cslug/core'
import { SessionStore } from '@cslug/core'

type Assertion = (res: TestResponse) => void | Promise<void>
export type Handler = (request: Request) => Promise<Response>

/** Cookies kept between the requests of one test (like a browser). */
export class CookieJar {
  readonly cookies = new Map<string, string>()
  header(): string | undefined {
    return this.cookies.size ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') : undefined
  }
  store(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';')
      const i = (pair ?? '').indexOf('=')
      if (i < 0) continue
      const name = (pair as string).slice(0, i).trim()
      const value = (pair as string).slice(i + 1).trim()
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  clear(): void {
    this.cookies.clear()
  }
}

/** A finished request, with assertions (also usable directly on a PendingRequest). */
export class TestResponse {
  private text?: string

  constructor(
    readonly response: Response,
    readonly request: Request,
    private readonly ctx: { app: Application; jar: CookieJar },
  ) {}

  get status(): number {
    return this.response.status
  }
  get headers(): Headers {
    return this.response.headers
  }
  async body(): Promise<string> {
    this.text ??= await this.response.clone().text()
    return this.text
  }
  async json<T = Record<string, unknown>>(): Promise<T> {
    return JSON.parse(await this.body()) as T
  }

  /** The session data after this request (from the session cookie), including flashed values. */
  async session(): Promise<Record<string, unknown>> {
    const name = this.ctx.app.config<string | undefined>('session.cookie') ?? 'cslug_session'
    const id = this.ctx.jar.cookies.get(name)
    if (!id) return {}
    const data = (await this.ctx.app.resolve(SessionStore).read(id)) ?? {}
    const { _flash, ...rest } = data as Record<string, unknown> & { _flash?: Record<string, unknown> }
    return { ...rest, ...(_flash ?? {}) }
  }

  describe(): string {
    return `${this.request.method} ${new URL(this.request.url).pathname} → ${this.status}`
  }
}

/**
 * A request being built; `await` runs it and every queued assertion:
 *
 * ```ts
 * await t.post('/fr/trip-request').form({ … }).assertRedirect('/fr/trip-request/thanks').assertSessionHas('success')
 * ```
 */
export class PendingRequest implements PromiseLike<TestResponse> {
  private readonly hdrs = new Headers()
  private body?: BodyInit
  private readonly assertions: Assertion[] = []
  private result?: Promise<TestResponse>

  constructor(
    private readonly method: string,
    private readonly path: string | (() => Promise<string>),
    private readonly ctx: {
      app: Application
      jar: CookieJar
      handle: Handler
      host: string
      before: ((r: PendingRequest) => void | Promise<void>)[]
    },
  ) {}

  // ── building ─────────────────────────────────────────────────────────────────────────────────────
  header(name: string, value: string): this {
    this.hdrs.set(name, value)
    return this
  }
  /** Several headers: `.headers(signWebhook('payments', payload))`. */
  headers(headers: Record<string, string>): this {
    for (const [k, v] of Object.entries(headers)) this.hdrs.set(k, v)
    return this
  }
  /** `Authorization: Bearer <token>`. */
  withToken(token: string): this {
    return this.header('authorization', `Bearer ${token}`)
  }
  /** A JSON body (also sets Accept: application/json). */
  json(data: unknown): this {
    this.hdrs.set('content-type', 'application/json')
    if (!this.hdrs.has('accept')) this.hdrs.set('accept', 'application/json')
    this.body = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    return this
  }
  /**
   * An HTML form post, as a browser sends it: nested objects as `a[b]`, arrays as `a[]`, the session's CSRF
   * token added automatically, a Referer (for redirect back) and `Accept: text/html`.
   */
  form(data: Record<string, unknown>): this {
    const params = new URLSearchParams()
    const add = (key: string, value: unknown) => {
      if (value === undefined || value === null) return
      if (Array.isArray(value)) for (const v of value) add(`${key}[]`, v)
      else if (typeof value === 'object' && !(value instanceof Date))
        for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v)
      else params.append(key, value instanceof Date ? value.toISOString() : String(value))
    }
    for (const [k, v] of Object.entries(data)) add(k, v)
    this.body = params
    this.formCsrf = true
    if (!this.hdrs.has('accept')) this.hdrs.set('accept', 'text/html')
    return this
  }
  private formCsrf = false

  // ── assertions (queued; run when awaited) ───────────────────────────────────────────────────────────
  private assert(fn: Assertion): this {
    this.assertions.push(fn)
    return this
  }
  assertStatus(status: number) {
    return this.assert(async (r) => expect(r.status, `${r.describe()}: ${await r.body()}`).toBe(status))
  }
  assertOk() {
    return this.assertStatus(200)
  }
  assertCreated() {
    return this.assertStatus(201)
  }
  assertNoContent() {
    return this.assertStatus(204)
  }
  assertNotFound() {
    return this.assertStatus(404)
  }
  assertForbidden() {
    return this.assertStatus(403)
  }
  assertUnauthorized() {
    return this.assertStatus(401)
  }
  /** 3xx, optionally to a location (a path matches the end of an absolute location). */
  assertRedirect(to?: string) {
    return this.assert((r) => {
      expect(r.status >= 300 && r.status < 400, `${r.describe()} is not a redirect`).toBe(true)
      if (to !== undefined) {
        const location = r.headers.get('location') ?? ''
        expect(location === to || location.endsWith(to) ? to : location).toBe(to)
      }
    })
  }
  /** A JSON body containing at least these fields (deep). */
  assertJson(subset: unknown) {
    return this.assert(async (r) => expect(await r.json()).toMatchObject(subset as object))
  }
  /** An RFC 9457 problem with this status and code. */
  assertProblem(status: number, code: string) {
    return this.assert(async (r) => {
      expect(r.status, r.describe()).toBe(status)
      expect((await r.json()).code).toBe(code)
    })
  }
  /**
   * Validation errors, for JSON (422 `errors`) and for HTML forms (redirect back, errors flashed).
   * Values are the expected message (or part of it) for each field.
   */
  assertInvalid(errors: Record<string, string>) {
    return this.assert(async (r) => {
      const found: Record<string, string[]> =
        r.status === 422
          ? ((await r.json()).errors as Record<string, string[]>)
          : (((await r.session())._errors as Record<string, string[]>) ?? {})
      for (const [field, message] of Object.entries(errors)) {
        expect(found[field] ?? [], `no error for "${field}" (errors: ${JSON.stringify(found)})`).toEqual(
          expect.arrayContaining([expect.stringContaining(message)]),
        )
      }
    })
  }
  /** The old input flashed after a failed form post. */
  assertOldInput(fields: Record<string, unknown>) {
    return this.assert(async (r) => expect((await r.session())._old ?? {}).toMatchObject(fields))
  }
  /** A session key (or flashed key), optionally with a value. */
  assertSessionHas(key: string, value?: unknown) {
    return this.assert(async (r) => {
      const session = await r.session()
      expect(session, `session has no "${key}"`).toHaveProperty([key])
      if (value !== undefined) expect(session[key]).toEqual(value)
    })
  }
  assertSessionMissing(key: string) {
    return this.assert(async (r) => expect(await r.session()).not.toHaveProperty([key]))
  }
  assertSee(text: string) {
    return this.assert(async (r) => expect(await r.body()).toContain(text))
  }
  assertDontSee(text: string) {
    return this.assert(async (r) => expect(await r.body()).not.toContain(text))
  }
  assertHeader(name: string, value?: string) {
    return this.assert((r) => {
      expect(r.headers.has(name), `no "${name}" header`).toBe(true)
      if (value !== undefined) expect(r.headers.get(name)).toBe(value)
    })
  }
  assertCookie(name: string) {
    return this.assert((r) =>
      expect(
        r.headers.getSetCookie().some((c) => c.startsWith(`${name}=`)),
        `no "${name}" cookie set`,
      ).toBe(true),
    )
  }

  /** Follow the redirect (GET, same cookies). */
  follow(): PendingRequest {
    return new PendingRequest(
      'GET',
      async () => {
        const r = await this
        const location = r.headers.get('location')
        if (!location) throw new Error(`${r.describe()} is not a redirect`)
        return location
      },
      this.ctx,
    )
  }

  // ── running ────────────────────────────────────────────────────────────────────────────────────────
  private async run(): Promise<TestResponse> {
    for (const hook of this.ctx.before) await hook(this)
    const path = typeof this.path === 'function' ? await this.path() : this.path
    const url = new URL(path, `http://${this.ctx.host}`)
    const cookie = this.ctx.jar.header()
    if (cookie && !this.hdrs.has('cookie')) this.hdrs.set('cookie', cookie)
    if (this.formCsrf) await this.addCsrf(url)
    const request = new Request(url, {
      method: this.method,
      headers: this.hdrs,
      body: this.method === 'GET' || this.method === 'HEAD' ? undefined : this.body,
    })
    const response = await this.ctx.handle(request)
    this.ctx.jar.store(response)
    const res = new TestResponse(response, request, this.ctx)
    for (const a of this.assertions) await a(res)
    return res
  }

  /** Put the session's CSRF token in the form (creating the session first if needed), and a Referer. */
  private async addCsrf(url: URL): Promise<void> {
    if (!this.hdrs.has('referer')) this.hdrs.set('referer', url.toString())
    const params = this.body as URLSearchParams
    if (params.has('_token')) return
    const name = this.ctx.app.config<string | undefined>('session.cookie') ?? 'cslug_session'
    const store = this.ctx.app.resolve(SessionStore)
    let id = this.ctx.jar.cookies.get(name)
    let data = id ? await store.read(id) : undefined
    if (!id || !data) {
      id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      data = {}
      this.ctx.jar.cookies.set(name, id)
      this.hdrs.set('cookie', this.ctx.jar.header() ?? '')
    }
    let token = data._token as string | undefined
    if (!token) {
      token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
      await store.write(id, { ...data, _token: token }, '1h')
    }
    params.set('_token', token)
  }

  // biome-ignore lint/suspicious/noThenProperty: a PendingRequest is awaited to run it
  then<A = TestResponse, B = never>(
    onFulfilled?: ((value: TestResponse) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.result ??= this.run()
    return this.result.then(onFulfilled, onRejected)
  }
}
