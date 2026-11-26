import { AppError, type Application, Logger, t, validationTranslator } from '@cslug/core'
import { ValidationError } from '@cslug/validation'
import type { HttpContext } from './context'
import { json } from './responses'

/** A renderer may return a Response for an error, or undefined to let the next one try. */
export type ErrorRenderer = (error: unknown, ctx: HttpContext) => Response | undefined | Promise<Response | undefined>
export type ErrorReporter = (error: unknown, ctx: HttpContext | undefined) => void

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * Turns errors into responses. Packages and apps add renderers in front (e.g. sessions: redirect back with
 * errors for HTML forms) and reporters (Sentry…). Default: RFC 9457 problem+json for API clients, a minimal HTML
 * page for browsers. Unknown errors are 500s with the request id; their details never leave the server in production.
 */
export class ExceptionHandler {
  readonly renderers: ErrorRenderer[] = []
  readonly reporters: ErrorReporter[] = []

  constructor(
    private readonly app: Application,
    private readonly log: Logger = Logger.null(),
  ) {}

  /** Add a renderer that runs before the defaults. */
  render(renderer: ErrorRenderer): this {
    this.renderers.unshift(renderer)
    return this
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
    for (const renderer of this.renderers) {
      const response = await renderer(error, ctx)
      if (response) return response
    }
    const back = this.formRedirect(error, ctx)
    if (back) return back
    return this.defaultResponse(error, ctx, status)
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

  protected problem(error: unknown, ctx: HttpContext, status: number) {
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
    if (ctx.request.wantsJson() || !(ctx.request.header('accept') ?? '').includes('text/html')) {
      headers.set('content-type', 'application/problem+json; charset=utf-8')
      return json(body, { status, headers })
    }
    headers.set('content-type', 'text/html; charset=utf-8')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${status} ${escapeHtml(body.title)}</title></head><body><h1>${status}</h1><p>${escapeHtml(body.title)}</p><p><small>Request ${escapeHtml(ctx.requestId)}</small></p></body></html>`
    return new Response(html, { status, headers })
  }
}
