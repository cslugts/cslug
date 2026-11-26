import { afterEach, describe, expect, test } from 'bun:test'
import { AppError, type Application, ConflictError, currentContext, inject, Logger, Money } from '@cslug/core'
import { type Fail, Validator, v } from '@cslug/validation'
import { created, download, type HttpContext, HttpKernel, redirect } from '../src'
import { bodyLimit, cors, timeout } from '../src/middleware'
import { httpApp } from './support'

let app: Application | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
})

// guide 07's validators, as used from controllers
const StoreTripRequestValidator = v.object({
  groupSize: v.int().min(1).max(12),
  budget: v.money({ currencies: ['EUR', 'USD'] }),
  interests: v.array(v.enum(['wildlife', 'hiking'])).default([]),
  newsletter: v.boolean().default(false),
  notes: v.string().optional(),
})

@inject.singleton()
class OperatorRepository {
  async existsBy({ email }: { email: string }) {
    return email === 'taken@example.test'
  }
}
@inject(OperatorRepository)
class RegisterOperatorValidator extends Validator {
  constructor(private operators: OperatorRepository) {
    super()
  }
  schema = v.object({ email: v.email() })
  async after(data: v.infer<this['schema']>, fail: Fail) {
    if (await this.operators.existsBy({ email: data.email })) fail('email', 'validation.unique')
  }
}

const routes = (r: Parameters<Parameters<typeof httpApp>[0]>[0]) => {
  r.post('/trips', async ({ request }: HttpContext) => created(await request.validate(StoreTripRequestValidator)))
  r.get('/search', async ({ request }) =>
    request.validate(v.object({ page: v.int().min(1).default(1), q: v.string().optional() })),
  )
  r.post('/operators', async ({ request }) => request.validate(RegisterOperatorValidator))
  r.post('/webhook', async ({ request }) => ({ bytes: (await request.raw()).length, parsed: await request.body() }))
  r.get('/money', () => ({ total: Money.of(220000n, 'EUR'), raw: 5n, at: new Date('2027-05-14T04:00:00Z') }))
  r.get('/conflict', () => {
    throw new ConflictError('booking.invalid_transition', { from: 'accepted', to: 'completed' })
  })
  r.get('/boom', () => {
    throw new Error('secret internal detail')
  })
  r.post('/accept', () => redirect().back('/fallback').with('success', 'ok'))
  r.get('/go', () => redirect().away('https://pay.example.test/checkout/1'))
  r.get('/file', () => download('a,b\n1,2\n', 'export.csv', 'text/csv'))
  r.get('/context', ({ requestId }) => ({ same: currentContext()?.requestId === requestId }))
  r.post('/big', async ({ request }) => {
    await request.body()
    return 'ok'
  }).middleware(bodyLimit('10b'))
  r.get('/slow', ({ signal }) => Bun.sleep(200).then(() => (signal.aborted ? 'aborted' : 'done'))).middleware(
    timeout('50ms'),
  )
  r.options('/api/x', () => null).middleware(cors({ origins: ['https://partner.test'] }))
  r.get('/api/x', () => ({ ok: true })).middleware(cors({ origins: ['https://partner.test'] }))
}
const jsonPost = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const formPost = (body: Record<string, string>) => ({ method: 'POST', body: new URLSearchParams(body) })

describe('requests and validation (guides 06, 07)', () => {
  test('JSON body validated and typed; 201', async () => {
    const h = await httpApp(routes)
    app = h.app
    const res = await h.call('/trips', jsonPost({ groupSize: 2, budget: { amount: '400000', currency: 'eur' } }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      groupSize: 2,
      budget: { amount: '400000', currency: 'EUR' },
      interests: [],
      newsletter: false,
    })
  })

  test('HTML forms: a[b] keys, numbers, checkboxes, repeated keys, empty optional fields', async () => {
    const h = await httpApp(routes)
    app = h.app
    const body = new URLSearchParams([
      ['groupSize', '4'],
      ['budget[amount]', '150000'],
      ['budget[currency]', 'USD'],
      ['interests[]', 'wildlife'],
      ['interests[]', 'hiking'],
      ['newsletter', 'on'],
      ['notes', ''],
    ])
    const res = await h.call('/trips', { method: 'POST', body })
    expect(await res.json()).toEqual({
      groupSize: 4,
      budget: { amount: '150000', currency: 'USD' },
      interests: ['wildlife', 'hiking'],
      newsletter: true,
    })
  })

  test('GET validates the query string, coerced', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/search?page=3&q=isalo')).json()).toEqual({ page: 3, q: 'isalo' })
    expect(await (await h.call('/search')).json()).toEqual({ page: 1 })
  })

  test('422 problem+json with every error, translated keys resolved to text', async () => {
    const h = await httpApp(routes)
    app = h.app
    const res = await h.call('/trips', jsonPost({ groupSize: 20, budget: { amount: 'x', currency: 'MGA' } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body).toMatchObject({ status: 422, code: 'validation.failed', title: 'The given data was invalid.' })
    expect(body.errors).toEqual({
      groupSize: ['Must be at most 12.'],
      'budget.amount': ['Must be a whole number.'],
      'budget.currency': ['Must be a supported currency.'],
    })
    expect(body.requestId).toBe(res.headers.get('x-request-id'))
  })

  test('a Validator class is built by the container (DI) and runs after()', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/operators', formPost({ email: 'new@example.test' }))).json()).toEqual({
      email: 'new@example.test',
    })
    const res = await h.call('/operators', {
      ...formPost({ email: 'taken@example.test' }),
      headers: { accept: 'application/json' },
    })
    expect([res.status, (await res.json()).errors]).toEqual([422, { email: ['This value is already taken.'] }])
  })

  test('raw body bytes are available alongside the parsed body (webhook signatures)', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/webhook', jsonPost({ id: 'evt_1' }))).json()).toEqual({
      bytes: 14,
      parsed: { id: 'evt_1' },
    })
    const bad = await h.call('/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    })
    expect([bad.status, (await bad.json()).code]).toEqual([400, 'http.invalid_json'])
  })
})

describe('responses and errors', () => {
  test('JSON: bigint as string, Money via toJSON, Date as ISO', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect(await (await h.call('/money')).json()).toEqual({
      total: { amount: '220000', currency: 'EUR' },
      raw: '5',
      at: '2027-05-14T04:00:00.000Z',
    })
  })

  test('AppError: status, code, params', async () => {
    const h = await httpApp(routes)
    app = h.app
    const res = await h.call('/conflict')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      code: 'booking.invalid_transition',
      params: { from: 'accepted', to: 'completed' },
    })
  })

  test('unknown errors: 500 with request id, logged; no detail in production; HTML page for browsers', async () => {
    const lines: string[] = []
    const h = await httpApp(routes, { app: { url: 'https://albastr.test', env: 'production' } })
    app = h.app
    h.app.swap(Logger, new Logger({ write: (l) => lines.push(l) }))
    const kernel = new HttpKernel(
      h.app,
      h.kernel.router,
      new (await import('../src')).ExceptionHandler(h.app, new Logger({ write: (l) => lines.push(l) })),
    ).compile()
    const res = await kernel.handle(
      new Request('http://albastr.test/boom', { headers: { accept: 'application/json' } }),
    )
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body).toEqual({
      type: 'https://albastr.test/errors/server.error',
      title: 'Something went wrong on our side.',
      status: 500,
      code: 'server.error',
      requestId: res.headers.get('x-request-id'),
    })
    expect(JSON.stringify(body)).not.toContain('secret internal detail')
    expect(lines.some((l) => l.includes('secret internal detail') && l.includes('"level":"error"'))).toBe(true) // but logged
    const html = await kernel.handle(new Request('http://albastr.test/boom', { headers: { accept: 'text/html' } }))
    expect(html.headers.get('content-type')).toContain('text/html')
    expect(await html.text()).toContain('<h1>500</h1>')
  })

  test('outside production, 500s include the detail for debugging', async () => {
    const h = await httpApp(routes)
    app = h.app
    expect((await (await h.call('/boom')).json()).detail).toBe('secret internal detail')
  })

  test('redirects: back (303 after POST) with fallback, away; download', async () => {
    const h = await httpApp(routes)
    app = h.app
    const back = await h.call('/accept', {
      method: 'POST',
      headers: { referer: 'https://albastr.test/bookings/b1/pay' },
    })
    expect([back.status, back.headers.get('location')]).toEqual([303, 'https://albastr.test/bookings/b1/pay'])
    expect((await h.call('/accept', { method: 'POST' })).headers.get('location')).toBe('/fallback')
    const away = await h.call('/go')
    expect([away.status, away.headers.get('location')]).toEqual([302, 'https://pay.example.test/checkout/1'])
    const file = await h.call('/file')
    expect(file.headers.get('content-disposition')).toContain('filename="export.csv"')
    expect(await file.text()).toBe('a,b\n1,2\n')
  })

  test('request id: accepted from the client or generated; in the context; on the response', async () => {
    const h = await httpApp(routes)
    app = h.app
    const given = await h.call('/context', { headers: { 'x-request-id': 'edge-123' } })
    expect([given.headers.get('x-request-id'), (await given.json()).same]).toEqual(['edge-123', true])
    expect(
      (await h.call('/context', { headers: { 'x-request-id': 'bad id with spaces' } })).headers.get('x-request-id'),
    ).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('middleware: security headers, body limit 413, timeout 503 (and the handler sees the abort), CORS', async () => {
    const h = await httpApp(routes)
    app = h.app
    const res = await h.call('/money')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect((await h.call('/big', { method: 'POST', body: 'x'.repeat(50) })).status).toBe(413)
    expect((await h.call('/slow')).status).toBe(503)
    const pre = await h.call('/api/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://partner.test', 'access-control-request-method': 'GET' },
    })
    expect([pre.status, pre.headers.get('access-control-allow-origin')]).toEqual([204, 'https://partner.test'])
    const other = await h.call('/api/x', { headers: { origin: 'https://evil.test' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('class middleware with DI; order: global → route', async () => {
    const order: string[] = []
    @inject(OperatorRepository)
    class RequireVerifiedOperatorMiddleware {
      constructor(private operators: OperatorRepository) {}
      async handle(_ctx: HttpContext, next: () => Promise<Response>) {
        order.push(`class (repo: ${typeof this.operators.existsBy})`)
        return next()
      }
    }
    const h = await httpApp((r) => {
      r.get('/m', () => {
        order.push('action')
        return 'ok'
      }).middleware(async (_c, next) => {
        order.push('route fn')
        return next()
      }, RequireVerifiedOperatorMiddleware)
    })
    app = h.app
    h.kernel.global.push(async (_c, next) => {
      order.push('global')
      return next()
    })
    expect(await (await h.call('/m')).text()).toBe('ok')
    expect(order).toEqual(['global', 'route fn', 'class (repo: function)', 'action'])
  })

  test('AppError subclasses from apps render with their status', async () => {
    class EscrowLocked extends AppError {
      constructor() {
        super('escrow.locked', 'Escrow is locked', { status: 423 })
      }
    }
    const h = await httpApp((r) => {
      r.get('/locked', () => {
        throw new EscrowLocked()
      })
    })
    app = h.app
    expect((await h.call('/locked')).status).toBe(423)
  })
})
