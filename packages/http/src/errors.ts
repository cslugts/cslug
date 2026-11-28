import { AppError, type Application, Logger, t, validationTranslator } from '@cslug/core'
import { ValidationError } from '@cslug/validation'
import type { HttpContext } from './context'
import { isResponsable, json } from './responses'

/** A renderer may return a Response for an error, or undefined to let the next one try. */
export type ErrorRenderer = (error: unknown, ctx: HttpContext) => Response | undefined | Promise<Response | undefined>
export type ErrorReporter = (error: unknown, ctx: HttpContext | undefined) => void

/** What `ExceptionHandler.problem()` describes an error as: the problem+json body, and the props of error views. */
export type Problem = {
  type: string
  title: string
  status: number
  code: string
  errors?: Record<string, string[]>
  params?: Record<string, unknown>
  requestId: string
  /** Development only, for 5xx. */
  detail?: string
  stack?: string[]
}

/** The HTML page for an error (error views, set by @cslug/vue): a Response, or undefined for the default page. */
export type ErrorPages = (
  error: unknown,
  ctx: HttpContext,
  problem: Problem,
) => Response | undefined | Promise<Response | undefined>

/** What an error handler method may return: a Response, a Responsable (`view()`), a JSON body, or nothing. */
export type HandlerResult =
  | Response
  | { toResponse(ctx: HttpContext): Response | Promise<Response> }
  | object
  | undefined

/** What `static handles` lists: error classes, statuses (`403`), `'4xx'`, `'5xx'`, or `'*'` for every error. */
export type HandlesEntry = (abstract new (...args: never[]) => unknown) | number | '4xx' | '5xx' | '*'

/** The optional methods of an error handler (not declared on `ErrorHandler`, so no `override` is needed). */
export type ErrorHandlerHooks<E = unknown> = {
  /** The page for a browser. */
  html?(error: E, ctx: HttpContext): HandlerResult | Promise<HandlerResult>
  /** The body for an API client (a plain object is sent with the error's status). */
  json?(error: E, ctx: HttpContext): HandlerResult | Promise<HandlerResult>
  /** Called whenever this handler matches an error, before rendering. */
  report?(error: E, ctx: HttpContext): unknown
}

/**
 * An app's own rendering for some errors (guide 06): an `@inject()` class in `app/exceptions/` with
 * `static handles` and `html` / `json` (and `report`) methods. A method that is missing or returns `undefined`
 * leaves the error to the next handler, then to the default.
 *
 * ```ts
 * export class PaymentDeclinedHandler extends ErrorHandler<PaymentDeclined> {
 *   static handles = [PaymentDeclined]
 *   html(error: PaymentDeclined) { return view(PaymentFailed, { reason: error.reason }, { status: 402 }) }
 *   json(error: PaymentDeclined) { return { code: 'payments.declined', reason: error.reason } }
 * }
 * ```
 */
export abstract class ErrorHandler<E = unknown> {
  declare readonly __error?: E
}

/** An error handler class. */
export type ErrorHandlerClass = (abstract new (
  ...args: never[]
) => ErrorHandler) & {
  readonly handles?: readonly HandlesEntry[]
}

export const isErrorHandlerClass = (value: unknown): value is ErrorHandlerClass =>
  typeof value === 'function' && value.prototype instanceof ErrorHandler

/** How well a `handles` entry matches an error: lower is better, undefined is no match. */
function rank(entry: unknown, error: unknown, status: number): number | undefined {
  if (typeof entry === 'function') {
    let depth = 0
    for (let p = Object.getPrototypeOf(error); p; p = Object.getPrototypeOf(p), depth++)
      if (p === (entry as { prototype: unknown }).prototype) return depth
    return undefined
  }
  // a form's ValidationError goes back to the form: only an explicit ValidationError entry takes it
  if (error instanceof ValidationError) return undefined
  if (entry === status) return 1_000
  if (entry === '4xx' && status >= 400 && status < 500) return 2_000
  if (entry === '5xx' && status >= 500) return 2_000
  if (entry === '*') return 3_000
  return undefined
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Turns errors into responses. Packages and apps add renderers in front (e.g. sessions: redirect back with
 * errors for HTML forms) and reporters (Sentry…). Default: RFC 9457 problem+json for API clients, a minimal HTML
 * page for browsers. Unknown errors are 500s with the request id; their details never leave the server in production.
 */
export class ExceptionHandler {
  readonly renderers: ErrorRenderer[] = []
  readonly reporters: ErrorReporter[] = []
  /** Error handler classes, in registration order (`use()`, and `app/exceptions/` at boot). */
  readonly handlers: ErrorHandlerClass[] = []
  private errorPages?: ErrorPages

  constructor(
    private readonly app: Application,
    private readonly log: Logger = Logger.null(),
  ) {}

  /** Add a renderer that runs before the defaults. */
  render(renderer: ErrorRenderer): this {
    this.renderers.unshift(renderer)
    return this
  }

  /** Register error handler classes (`HttpProvider` registers those of `app/exceptions/`). */
  use(...handlers: ErrorHandlerClass[]): this {
    for (const h of handlers) if (!this.handlers.includes(h)) this.handlers.push(h)
    return this
  }

  /** Set the HTML page renderer used when no handler answered (`@cslug/vue` sets error views). */
  pages(renderer: ErrorPages): this {
    this.errorPages = renderer
    return this
  }

  /** The handlers for an error, best match first. */
  matching(error: unknown, status: number): ErrorHandlerClass[] {
    const ranked: [number, number, ErrorHandlerClass][] = []
    this.handlers.forEach((h, i) => {
      const best = (h.handles ?? [])
        .map((entry) => rank(entry, error, status))
        .filter((r): r is number => r !== undefined)
        .sort((a, b) => a - b)[0]
      if (best !== undefined) ranked.push([best, i, h])
    })
    return ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , h]) => h)
  }

  /** Whether the client asked for JSON (an API client, an island, or no `text/html` in `Accept`). */
  wantsJson(ctx: HttpContext): boolean {
    return ctx.request.wantsJson() || !(ctx.request.header('accept') ?? '').includes('text/html')
  }

  /** Add an error reporter (called for 5xx errors). */
  report(reporter: ErrorReporter): this {
    this.reporters.push(reporter)
    return this
  }

  status(error: unknown): number {
    if (error instanceof ValidationError) return 422
    if (error instanceof AppError) return error.status
    const s = (error as { status?: unknown })?.status
    return typeof s === 'number' && s >= 400 && s < 600 ? s : 500
  }

  async handle(error: unknown, ctx: HttpContext): Promise<Response> {
    const status = this.status(error)
    if (status >= 500) {
      this.log.error('request failed', { error, requestId: ctx.requestId, path: ctx.request.path })
      for (const r of this.reporters) {
        try {
          r(error, ctx)
        } catch {}
      }
    }
    const matched = this.matching(error, status)
    const handlers: (ErrorHandler & ErrorHandlerHooks)[] = []
    for (const cls of matched) {
      try {
        // built by the container (with @inject); a handler without dependencies needs no @inject
        const handler = (
          this.app.has(cls as never)
            ? ctx.scope.resolve(cls as never)
            : new (cls as unknown as new () => ErrorHandler)()
        ) as ErrorHandler & ErrorHandlerHooks
        handlers.push(handler)
        await handler.report?.(error, ctx)
      } catch (failure) {
        this.log.error('http.error_handler_failed', { handler: cls.name, error: failure, requestId: ctx.requestId })
      }
    }
    for (const renderer of this.renderers) {
      const response = await renderer(error, ctx)
      if (response) return response
    }
    const asJson = this.wantsJson(ctx)
    for (const handler of handlers) {
      try {
        const result = await (asJson ? handler.json?.(error, ctx) : handler.html?.(error, ctx))
        if (result !== undefined) return await this.asResponse(result, ctx, status)
      } catch (failure) {
        this.log.error('http.error_handler_failed', {
          handler: handler.constructor.name,
          error: failure,
          requestId: ctx.requestId,
        })
        return this.defaultResponse(error, ctx, status)
      }
    }
    const back = this.formRedirect(error, ctx)
    if (back) return back
    if (!asJson && this.errorPages) {
      try {
        const page = await this.errorPages(error, ctx, this.problem(error, ctx, status))
        if (page) return this.withRetryAfter(page, error)
      } catch (failure) {
        this.log.error('http.error_page_failed', { error: failure, requestId: ctx.requestId })
      }
    }
    return this.defaultResponse(error, ctx, status)
  }

  /** What a handler returned, as a Response: a plain object is sent as JSON with the error's status. */
  private async asResponse(result: HandlerResult, ctx: HttpContext, status: number): Promise<Response> {
    if (result instanceof Response) return result
    if (isResponsable(result)) return result.toResponse(ctx)
    return json(result, { status })
  }

  private withRetryAfter(res: Response, error: unknown): Response {
    const retry = (error as { retryAfter?: number }).retryAfter
    if (retry && !res.headers.has('retry-after')) res.headers.set('retry-after', String(retry))
    return res
  }

  /**
   * A failed HTML form post goes back to the form with the errors and the input flashed, so the page can show
   * them. JSON clients, GET requests and routes without a session get problem+json instead.
   */
  protected formRedirect(error: unknown, ctx: HttpContext): Response | undefined {
    if (!(error instanceof ValidationError) || ctx.request.wantsJson() || ctx.request.method === 'GET') return undefined
    if (!ctx.session.available) return undefined
    ctx.session.flash('_errors', error.messages(validationTranslator(ctx.locale)))
    ctx.session.flash('_old', this.oldInput(ctx))
    return new Response(null, { status: 303, headers: { location: ctx.request.header('referer') ?? '/' } })
  }

  /** The submitted input to show again: without passwords, tokens and files. */
  protected oldInput(ctx: HttpContext): Record<string, unknown> {
    const body = ctx.request.parsedBody ?? {}
    return Object.fromEntries(
      Object.entries(body).filter(([k, v]) => !/password|token|^_/.test(k.toLowerCase()) && !(v instanceof Blob)),
    )
  }

  /** The error as problem+json (RFC 9457): the default JSON body, and the props of error views. */
  problem(error: unknown, ctx: HttpContext, status = this.status(error)): Problem {
    const production = this.app.config('app.env') === 'production'
    const code =
      error instanceof ValidationError
        ? 'validation.failed'
        : status >= 500
          ? 'server.error'
          : ((error as { code?: string }).code ?? 'http.error')
    const fallback =
      error instanceof ValidationError
        ? 'The given data was invalid.'
        : status >= 500
          ? 'Something went wrong on our side.'
          : ((error as Error).message ?? 'Error')
    const translated = t(code, (error as AppError).params ?? {})
    const title = translated !== code ? translated : fallback
    const base =
      this.app.config<string | undefined>('http.problemBase') ??
      `${this.app.config<string | undefined>('app.url') ?? ''}/errors`
    return {
      type: `${base}/${code}`,
      title,
      status,
      code,
      ...(error instanceof ValidationError ? { errors: error.messages(validationTranslator(ctx.locale)) } : {}),
      ...((error as AppError).params && status < 500 ? { params: (error as AppError).params } : {}),
      requestId: ctx.requestId,
      ...(status >= 500 && !production
        ? { detail: (error as Error)?.message, stack: (error as Error)?.stack?.split('\n').slice(0, 8) }
        : {}),
    }
  }

  protected defaultResponse(error: unknown, ctx: HttpContext, status: number): Response {
    const body = this.problem(error, ctx, status)
    const headers = new Headers()
    const retry = (error as { retryAfter?: number }).retryAfter
    if (retry) headers.set('retry-after', String(retry))
    if (this.wantsJson(ctx)) {
      headers.set('content-type', 'application/problem+json; charset=utf-8')
      return json(body, { status, headers })
    }
    headers.set('content-type', 'text/html; charset=utf-8')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${status} ${escapeHtml(body.title)}</title></head><body><h1>${status}</h1><p>${escapeHtml(body.title)}</p><p><small>Request ${escapeHtml(ctx.requestId)}</small></p></body></html>`
    return new Response(html, { status, headers })
  }
}
