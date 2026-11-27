import type { HttpContext } from './context'
import { route, type UrlOptions } from './url'

/** Anything a handler returns that knows how to become a Response (views, redirects…). */
export interface Responsable {
  toResponse(ctx: HttpContext): Response | Promise<Response>
}
/** Duck-typed so responsables from other packages (vue views) need no shared base class. */
export const isResponsable = (v: unknown): v is Responsable =>
  typeof v === 'object' && v !== null && typeof (v as Responsable).toResponse === 'function'

/** JSON with bigint → string, Date → ISO, and `toJSON()` (Money) respected. */
export function json(data: unknown, init: ResponseInit = {}): Response {
  const body = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
  return new Response(body, { ...init, headers })
}

export const created = (data?: unknown) => json(data ?? null, { status: 201 })
export const accepted = (data?: unknown) => json(data ?? null, { status: 202 })
export const noContent = () => new Response(null, { status: 204 })

/** A file download. `content` may be a Bun file, bytes or a string. */
export function download(content: Blob | Uint8Array<ArrayBuffer> | string, filename: string, type?: string): Response {
  const blob = content instanceof Blob ? content : new Blob([content], { type: type ?? 'application/octet-stream' })
  return new Response(blob, {
    headers: {
      'content-type': type ?? (blob.type || 'application/octet-stream'),
      'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  })
}

/** Stream text or bytes (CSV exports…). */
export function stream(source: AsyncIterable<string | Uint8Array>, type = 'text/plain; charset=utf-8'): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of source) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': type } })
}

/** Server-sent events: each item becomes a `data:` event (objects as JSON). */
export function sse(source: AsyncIterable<unknown>): Response {
  return stream(
    (async function* () {
      for await (const item of source) yield `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`
    })(),
    'text/event-stream',
  )
}

/** `redirect().route(...)`, `.to(url)`, `.back()`, `.away(url)`, `.with(key, message)` (flash, with sessions). */
export class Redirect implements Responsable {
  private target?: string
  private toReferrer = false
  private status = 302
  readonly flashes: Record<string, unknown> = {}

  to(url: string): this {
    this.target = url
    return this
  }
  route(name: string, params: Record<string, unknown> = {}, options: UrlOptions = {}): this {
    this.target = route(name, params, options)
    return this
  }
  /** To an external URL (payment checkout…). */
  away(url: string): this {
    this.target = url
    return this
  }
  /** Back to the previous page (Referer), or `fallback`. */
  back(fallback = '/'): this {
    this.toReferrer = true
    this.target = fallback
    return this
  }
  /** After login: the page the user wanted, else `fallback` (needs sessions). */
  private useIntended = false
  /** After login: the page the user wanted before being sent to login, else `fallback`. */
  intended(fallback: string): this {
    this.target = fallback
    this.useIntended = true
    return this
  }
  /** Flash a value for the next request: `.with('success', t('saved'))` (needs the session middleware). */
  with(key: string, value: unknown): this {
    this.flashes[key] = value
    return this
  }
  withStatus(status: 301 | 302 | 303 | 307 | 308): this {
    this.status = status
    return this
  }

  toResponse(ctx: HttpContext): Response {
    const referrer = this.toReferrer ? ctx.request.header('referer') : undefined
    let location = referrer ?? this.target ?? '/'
    if (this.useIntended) location = ctx.session.pull<string>('url.intended') ?? location
    for (const [k, v] of Object.entries(this.flashes)) ctx.session.flash(k, v)
    // a request from @cslug/vue's useForm / http (fetch): the URL to go to, which fetch could not read from a 3xx
    if (ctx.request.header('x-cslug-request') === '1')
      return new Response(null, { status: 204, headers: { 'x-cslug-redirect': location } })
    // 303 after non-GET so the browser follows with GET
    const status =
      this.status === 302 && ctx.request.method && !['GET', 'HEAD'].includes(ctx.request.method) ? 303 : this.status
    return new Response(null, { status, headers: { location } })
  }
}

export const redirect = () => new Redirect()
