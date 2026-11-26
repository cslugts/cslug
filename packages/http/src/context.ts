import { type Application, BadRequestError, type Container, type Logger, type Resolved, type Token } from '@cslug/core'
import { type Output, type Schema, type Validatable, Validator, validate } from '@cslug/validation'
import { coerceForm, nestKeys } from './body'
import type { Session } from './session'

type ValidatorClass = abstract new (...args: never[]) => Validator
/** What `request.validate()` accepts: a schema, a Validator instance or class, a Standard Schema. */
export type Validated<T> = T extends ValidatorClass ? Output<InstanceType<T>> : Output<T>

/** The incoming request, with parsed input. Body bytes are read once and cached. */
export class HttpRequest {
  private bytes?: Promise<Uint8Array<ArrayBuffer>>
  /** Maximum body size in bytes (set by the `bodyLimit` middleware), enforced on the bytes actually read. */
  maxBodyBytes?: number
  private parsed?: Promise<Record<string, unknown>>
  readonly url: URL

  constructor(
    readonly raw_: Request,
    private readonly scope: Container,
    readonly ip_: string | undefined,
  ) {
    this.url = new URL(raw_.url)
  }

  get method(): string {
    return this.raw_.method
  }
  get path(): string {
    return this.url.pathname
  }
  get headers(): Headers {
    return this.raw_.headers
  }
  header(name: string): string | undefined {
    return this.raw_.headers.get(name) ?? undefined
  }
  /** Client IP (from the socket; `X-Forwarded-For` only behind trusted proxies, handled by the kernel). */
  ip(): string | undefined {
    return this.ip_
  }

  private cookieJar?: Map<string, string>
  /** A cookie sent by the client. */
  cookie(name: string): string | undefined {
    if (!this.cookieJar) {
      this.cookieJar = new Map()
      for (const part of (this.header('cookie') ?? '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0) {
          try {
            this.cookieJar.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()))
          } catch {}
        }
      }
    }
    return this.cookieJar.get(name)
  }

  /** One query parameter. */
  query(key: string): string | undefined {
    return this.url.searchParams.get(key) ?? undefined
  }
  /** All query parameters, with `a[b]` nesting. */
  queryAll(): Record<string, unknown> {
    return nestKeys(this.url.searchParams.entries())
  }

  /** The body as bytes (for webhook signatures). */
  raw(): Promise<Uint8Array<ArrayBuffer>> {
    this.bytes ??= this.raw_.arrayBuffer().then((b) => {
      if (this.maxBodyBytes !== undefined && b.byteLength > this.maxBodyBytes) {
        throw Object.assign(new BadRequestError('http.payload_too_large', 'The request body is too large.'), {
          status: 413,
        })
      }
      return new Uint8Array(b)
    })
    return this.bytes
  }

  get contentType(): string {
    return (this.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  }
  get isJson(): boolean {
    return this.contentType === 'application/json' || this.contentType.endsWith('+json')
  }
  get isForm(): boolean {
    return this.contentType === 'application/x-www-form-urlencoded' || this.contentType === 'multipart/form-data'
  }

  /** The client prefers JSON (an API call or `fetch` from an island) over an HTML page. */
  wantsJson(): boolean {
    const accept = this.header('accept') ?? ''
    return (
      this.isJson ||
      accept.includes('application/json') ||
      (!accept.includes('text/html') && this.header('x-requested-with') === 'XMLHttpRequest')
    )
  }

  /** The parsed body: JSON, or a form (nested keys, files as File). GET/HEAD → the query string. */
  body(): Promise<Record<string, unknown>> {
    this.parsed ??= this.parse().then((b) => {
      this.parsedBody = b
      return b
    })
    return this.parsed
  }

  /** The parsed body once it has been read (sync access for error renderers); undefined before. */
  parsedBody?: Record<string, unknown>

  private async parse(): Promise<Record<string, unknown>> {
    if (this.method === 'GET' || this.method === 'HEAD') return this.queryAll()
    const bytes = await this.raw()
    if (!bytes.length) return {}
    if (this.isJson) {
      try {
        const value = JSON.parse(new TextDecoder().decode(bytes))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
      } catch {
        throw new BadRequestError('http.invalid_json', 'The request body is not valid JSON.')
      }
    }
    if (this.isForm) {
      const form = await new Request(this.raw_.url, {
        method: 'POST',
        headers: this.raw_.headers,
        body: bytes,
      }).formData()
      return nestKeys(form.entries())
    }
    return {}
  }

  /** One input value (body for POST/PUT/PATCH/DELETE, query for GET). Prefer `validate()` for writes. */
  async input(key: string): Promise<unknown> {
    return (await this.body())[key]
  }

  /** A file from a multipart body. */
  async file(key: string): Promise<File | undefined> {
    const v = (await this.body())[key]
    return v instanceof File ? v : undefined
  }

  /**
   * Validate the input and return it typed: `await request.validate(StoreTripRequestValidator)`.
   * GET reads the query string; other methods the body. Form and query strings are coerced to the schema
   * (numbers, checkboxes, arrays, empty → undefined). Throws `ValidationError` (422).
   */
  async validate<T extends Validatable | ValidatorClass>(
    target: T,
    options: { from?: 'body' | 'query' } = {},
  ): Promise<Validated<T>> {
    const instance =
      typeof target === 'function'
        ? (this.scope.resolve(target as unknown as Token<Validator>) as Validator)
        : (target as Validatable)
    const fromQuery =
      options.from === 'query' || (options.from === undefined && (this.method === 'GET' || this.method === 'HEAD'))
    let input: unknown = fromQuery ? this.queryAll() : await this.body()
    const schema = instance instanceof Validator ? instance.schema : instance
    if ((fromQuery || this.isForm) && isCslugSchema(schema)) input = coerceForm(schema, input)
    return (await validate(instance, input)) as Validated<T>
  }
}

const isCslugSchema = (s: unknown): s is Schema => typeof s === 'object' && s !== null && '_def' in s && '_run' in s

/** Outgoing response details set by the handler (cookies, extra headers). */
export class ResponseBuilder {
  readonly headers = new Headers()
  status?: number

  header(name: string, value: string): this {
    this.headers.set(name, value)
    return this
  }
  /** `Set-Cookie`, defaults: HttpOnly, Secure (in production), SameSite=Lax, Path=/. */
  cookie(
    name: string,
    value: string,
    options: {
      maxAge?: number
      httpOnly?: boolean
      secure?: boolean
      sameSite?: 'lax' | 'strict' | 'none'
      path?: string
      domain?: string
    } = {},
  ): this {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      `Path=${options.path ?? '/'}`,
      `SameSite=${options.sameSite ?? 'Lax'}`,
    ]
    if (options.httpOnly !== false) parts.push('HttpOnly')
    if (options.secure ?? process.env.APP_ENV === 'production') parts.push('Secure')
    if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
    if (options.domain) parts.push(`Domain=${options.domain}`)
    this.headers.append('set-cookie', parts.join('; '))
    return this
  }
}

/**
 * What a handler receives. Packages add fields with module augmentation
 * (`declare module '@cslug/http' { interface HttpContext { auth: Auth } }`).
 */
export interface HttpContext {
  readonly request: HttpRequest
  /** Route parameters (path and domain), URL-decoded strings. */
  readonly params: Record<string, string>
  readonly response: ResponseBuilder
  readonly app: Application
  readonly scope: Container
  readonly requestId: string
  /** Aborted when the client disconnects or a `timeout()` middleware fires. */
  readonly signal: AbortSignal
  /** Logger bound to this request. */
  readonly log: Logger
  /** The current locale (set by the locale middleware; the default locale otherwise). */
  locale: string
  /** The session (needs the `session()` middleware, which routes/web.ts has). */
  session: Session
  /** Name of the matched route. */
  readonly routeName?: string
  /** Resolve from the request scope. */
  resolve<K extends Token>(token: K): Resolved<K>
}
