import { describe, expect, test } from 'bun:test'
import { AppError, Application, ForbiddenError, inject, Logger, NotFoundError } from '@cslug/core'
import { ValidationError } from '@cslug/validation'
import {
  ErrorHandler,
  type ErrorHandlerClass,
  ExceptionHandler,
  type HttpContext,
  HttpKernel,
  HttpProvider,
  Router,
} from '../src'
import { session } from '../src/middleware'
import { PaymentDeclined } from './fixture-exceptions/errors'
import { httpApp } from './support'

const html = { accept: 'text/html' }
const api = { accept: 'application/json' }

class TeapotError extends AppError {
  constructor() {
    super('teapot', "I'm a teapot", { status: 418 })
  }
}

/** Records which handler answered. */
const page = (name: string, status: number) =>
  new Response(name, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })

class AppErrorHandler extends ErrorHandler {
  static handles = [AppError]
  html(error: AppError) {
    return page('app-error', error.status)
  }
}
class PaymentHandler extends ErrorHandler<PaymentDeclined> {
  static handles = [PaymentDeclined]
  html() {
    return page('payment', 402)
  }
  json(error: PaymentDeclined) {
    return { code: 'payments.declined', reason: error.reason } // a plain object: the error's status
  }
}
class ForbiddenHandler extends ErrorHandler {
  static handles = [403]
  html() {
    return page('forbidden', 403)
  }
}
class ClientErrors extends ErrorHandler {
  static handles = ['4xx'] as const
  html(_e: unknown, ctx: HttpContext) {
    return page(`4xx ${ctx.requestId ? 'with ctx' : ''}`, 499)
  }
}
class Everything extends ErrorHandler {
  static handles = ['*'] as const
  html() {
    return page('everything', 500)
  }
}

async function appWith(...handlers: ErrorHandlerClass[]) {
  const h = await httpApp((r) => {
    r.get('/pay', () => {
      throw new PaymentDeclined('card expired')
    })
    r.get('/teapot', () => {
      throw new TeapotError()
    })
    r.get('/forbidden', () => {
      throw new ForbiddenError()
    })
    r.get('/missing', () => {
      throw new NotFoundError('booking', 'b1')
    })
    r.get('/boom', () => {
      throw new Error('db down')
    })
    r.group({ middleware: [session()] }, (r) => {
      r.post('/form', () => {
        throw new ValidationError({ title: ['validation.required'] })
      })
    })
  })
  h.app.resolve(ExceptionHandler).use(...handlers)
  return h
}

describe('error handlers (guide 06)', () => {
  test('the nearest error class wins, then the status, then 4xx/5xx, then *', async () => {
    const { call } = await appWith(Everything, ClientErrors, ForbiddenHandler, AppErrorHandler, PaymentHandler)
    expect(await (await call('/pay', { headers: html })).text()).toBe('payment') // PaymentDeclined over AppError
    expect(await (await call('/teapot', { headers: html })).text()).toBe('app-error') // a class over 4xx
    expect(await (await call('/forbidden', { headers: html })).text()).toBe('app-error') // ForbiddenError is an AppError
    expect(await (await call('/boom', { headers: html })).text()).toBe('everything') // * for a plain Error

    const { call: byStatus } = await appWith(Everything, ClientErrors, ForbiddenHandler)
    expect(await (await byStatus('/forbidden', { headers: html })).text()).toBe('forbidden') // 403 over 4xx
    expect(await (await byStatus('/teapot', { headers: html })).text()).toBe('4xx with ctx') // 4xx over *
    expect(await (await byStatus('/nowhere', { headers: html })).text()).toBe('4xx with ctx') // an unknown route too
  })

  test('html for browsers, json for API clients; a plain object is sent with the error status', async () => {
    const { call } = await appWith(PaymentHandler)
    const res = await call('/pay', { headers: api })
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({ code: 'payments.declined', reason: 'card expired' })
    expect(await (await call('/pay', { headers: html })).text()).toBe('payment')
  })

  test('a missing method, or undefined, leaves the error to the next handler, then the default', async () => {
    class OnlyJson extends ErrorHandler {
      static handles = [TeapotError]
      json() {
        return undefined
      }
    }
    const { call } = await appWith(OnlyJson, ClientErrors)
    expect(await (await call('/teapot', { headers: html })).text()).toBe('4xx with ctx') // OnlyJson has no html
    const res = await call('/teapot', { headers: api }) // OnlyJson returned undefined; ClientErrors has no json
    expect(res.status).toBe(418)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })

  test('a form ValidationError still goes back to the form: status and * handlers do not take it', async () => {
    const { call } = await appWith(Everything, ClientErrors)
    const res = await call('/form', { method: 'POST', headers: { ...html, referer: 'http://example.test/new' } })
    expect([res.status, res.headers.get('location')]).toEqual([303, 'http://example.test/new'])
  })

  test('handlers are built by the container; report() runs when a handler matches', async () => {
    const reported: string[] = []
    @inject.singleton()
    class Alerts {
      send(message: string) {
        reported.push(message)
      }
    }
    @inject(Alerts)
    class AlertingHandler extends ErrorHandler {
      static handles = ['5xx'] as const
      constructor(private alerts: Alerts) {
        super()
      }
      report(error: Error) {
        this.alerts.send(error.message)
      }
    }
    const { call } = await appWith(AlertingHandler)
    expect((await call('/boom', { headers: html })).status).toBe(500) // no html(): the default page
    expect(reported).toEqual(['db down'])
  })

  test('a handler that throws: logged, and the default response', async () => {
    const lines: string[] = []
    class Broken extends ErrorHandler {
      static handles = ['*'] as const
      html(): Response {
        throw new Error('the handler is broken')
      }
    }
    const h = await appWith(Broken)
    const handler = new ExceptionHandler(h.app, new Logger({ write: (l) => lines.push(String(l)) })).use(Broken)
    const kernel = new HttpKernel(h.app, h.kernel.router, handler).compile()
    const res = await kernel.handle(new Request('http://example.test/teapot', { headers: html }))
    expect(res.status).toBe(418)
    expect(await res.text()).toContain('418')
    expect(lines.join('\n')).toContain('http.error_handler_failed')
  })

  test('HttpProvider registers the handlers of app/exceptions/ (subfolders too)', async () => {
    const app = new Application({
      root: `${import.meta.dir}/fixture-exceptions`,
      configs: { app: { url: 'https://example.test', key: 'k'.repeat(32), env: 'test' } },
    })
    app.useProviders([HttpProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
    app.resolve(Router).load((r) => {
      r.get('/pay', () => {
        throw new PaymentDeclined('insufficient funds')
      })
    })
    const kernel = app.resolve(HttpKernel).compile()
    expect(app.resolve(ExceptionHandler).handlers.map((h) => h.name)).toEqual(['PaymentDeclinedHandler'])
    const res = await kernel.handle(new Request('http://example.test/pay', { headers: html }))
    expect([res.status, await res.text()]).toEqual([402, '<p>Declined: insufficient funds</p>'])
    await app.shutdown()
  })
})
