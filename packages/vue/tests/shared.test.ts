import { afterEach, describe, expect, test } from 'bun:test'
import { defineStore, http, useForm } from '../src'
import { formatDateIn, formatDurationIn, formatMoneyIn } from '../src/shared/format'
import { buildUrl } from '../src/shared/url'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const respond = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return calls
}

describe('useForm (guide 08 § useForm reference)', () => {
  test('success: JSON body, Accept JSON, response kept, processing resets', async () => {
    const calls = respond(201, { id: 't1', title: 'Bread' })
    const form = useForm({ title: 'Bread', tags: ['a'] })
    expect(await form.post('/todos')).toBe(true)
    expect(calls[0]?.init).toMatchObject({ method: 'POST', body: '{"title":"Bread","tags":["a"]}' })
    expect(calls[0]?.init.headers).toMatchObject({ accept: 'application/json', 'content-type': 'application/json' })
    expect([form.response, form.processing]).toEqual([{ id: 't1', title: 'Bread' }, false])
  })

  test('422: first message per field; cleared on the next submit; other failures in form.error', async () => {
    respond(422, {
      status: 422,
      code: 'validation.failed',
      errors: { title: ['Required.', 'Too short.'], dueOn: ['Must be a date.'] },
    })
    const form = useForm({ title: '', dueOn: 'x' })
    expect(await form.post('/todos')).toBe(false)
    expect(form.errors).toEqual({ title: 'Required.', dueOn: 'Must be a date.' })
    respond(419, { title: 'Page Expired', detail: 'The page expired. Reload it and try again.' })
    expect(await form.put('/todos/1')).toBe(false)
    expect([form.errors, form.error]).toEqual([{}, 'The page expired. Reload it and try again.'])
  })

  test('delete without fields sends no body; reset restores the initial data', async () => {
    const calls = respond(200, {})
    const form = useForm({})
    await form.delete('/todos/1')
    expect(calls[0]?.init.body).toBeUndefined()
    const edit = useForm({ title: 'a' })
    edit.data.title = 'b'
    edit.reset()
    expect(edit.data.title).toBe('a')
  })
})

/** A fetch that answers with `reply(url, init)` and records the calls. */
const stub = (reply: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return reply(url, init)
  }) as typeof fetch
  return calls
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('useForm: callbacks, redirects, state (Inertia names)', () => {
  test("callbacks: the form's then the call's; onBefore false cancels before any request", async () => {
    const calls = stub(() => json(201, { id: 't1' }))
    const order: string[] = []
    const form = useForm(
      { title: 'Bread' },
      {
        onStart: () => order.push('form:start'),
        onSuccess: (r) => order.push(`form:success:${(r as { id: string }).id}`),
        onFinish: () => order.push('form:finish'),
      },
    )
    expect(
      await form.post('/todos', {
        onBefore: () => {
          order.push('call:before')
        },
        onSuccess: () => order.push('call:success'),
        onFinish: () => order.push('call:finish'),
      }),
    ).toBe(true)
    expect(order).toEqual([
      'call:before',
      'form:start',
      'form:success:t1',
      'call:success',
      'form:finish',
      'call:finish',
    ])
    expect(calls[0]?.init.headers).toMatchObject({ 'x-cslug-request': '1' })
    expect(await form.post('/todos', { onBefore: () => false })).toBe(false)
    expect(calls).toHaveLength(1)
  })

  test('onError: field errors for a 422; status and message for other failures and network errors', async () => {
    stub(() => json(422, { errors: { title: ['Required.'] } }))
    const seen: unknown[] = []
    const form = useForm({ title: '' }, { onError: (errors, info) => seen.push([errors, info]) })
    await form.post('/todos')
    expect(seen.at(-1)).toEqual([{ title: 'Required.' }, { status: 422, message: null }])
    expect(form.hasErrors).toBe(true)
    stub(() => json(500, { title: 'Server error', detail: 'Something broke.' }))
    await form.post('/todos')
    expect(seen.at(-1)).toEqual([{}, { status: 500, message: 'Something broke.' }])
    expect([form.hasErrors, form.error]).toEqual([false, 'Something broke.'])
    stub(() => {
      throw new TypeError('Failed to fetch')
    })
    await form.post('/todos')
    expect(seen.at(-1)).toEqual([{}, { status: 0, message: 'Failed to fetch' }])
  })

  test('a server redirect() reaches onSuccess as `redirect` (followed unless followRedirects: false)', async () => {
    stub(() => new Response(null, { status: 204, headers: { 'x-cslug-redirect': '/todos/t1' } }))
    let info: unknown
    const form = useForm({ title: 'x' })
    expect(await form.post('/todos', { followRedirects: false, onSuccess: (_r, i) => (info = i) })).toBe(true)
    expect(info).toEqual({ redirect: '/todos/t1' })
  })

  test('cancel(), and a newer submission aborting the one in flight', async () => {
    stub(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
        ),
    )
    const events: string[] = []
    const form = useForm({}, { onCancel: () => events.push('cancel'), onFinish: () => events.push('finish') })
    const first = form.post('/slow')
    expect(form.processing).toBe(true)
    form.cancel()
    expect(await first).toBe(false)
    expect([form.processing, events]).toEqual([false, ['cancel', 'finish']])
    const a = form.post('/slow')
    stub(() => json(200, { ok: true }))
    const b = form.post('/fast')
    expect([await a, await b]).toEqual([false, true])
    expect(form.processing).toBe(false)
  })

  test('isDirty, wasSuccessful, recentlySuccessful, reset(field), defaults(), setError, transform', async () => {
    const calls = stub(() => json(200, {}))
    const form = useForm({ title: 'a', notes: 'n', remember: 'on' })
    expect(form.isDirty).toBe(false)
    form.data.title = 'b'
    form.data.notes = 'm'
    expect(form.isDirty).toBe(true)
    form.reset('title')
    expect([form.data.title, form.data.notes]).toEqual(['a', 'm'])
    form.defaults()
    expect(form.isDirty).toBe(false)
    form.setError('title', 'Taken.')
    form.setError({ notes: 'Too long.' })
    expect(form.errors).toEqual({ title: 'Taken.', notes: 'Too long.' })
    form.clearErrors('title')
    expect(form.errors).toEqual({ notes: 'Too long.' })
    await form.transform((d) => ({ ...d, remember: d.remember === 'on' })).post('/x')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: 'a', notes: 'm', remember: true })
    expect([form.wasSuccessful, form.recentlySuccessful, form.hasErrors]).toEqual([true, true, false])
  })

  test("files: multipart with the server's key syntax (no JSON content type); dates as ISO", async () => {
    const calls = stub(() => json(200, {}))
    const photo = new File(['png'], 'photo.png', { type: 'image/png' })
    const form = useForm({
      caption: 'Isalo',
      tags: ['a', 'b'],
      meta: { lang: 'fr' },
      photo,
      at: new Date('2026-11-27T00:00:00Z'),
    })
    await form.post('/photos')
    const body = calls[0]?.init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect([...body.keys()]).toEqual(['caption', 'tags[]', 'tags[]', 'meta[lang]', 'photo', 'at'])
    const sent = body.get('photo') as File
    expect([sent.name, sent.type, await sent.text()]).toEqual(['photo.png', 'image/png', 'png'])
    expect(body.get('at')).toBe('2026-11-27T00:00:00.000Z')
    expect(calls[0]?.init.headers).not.toHaveProperty('content-type')
  })

  test("submit(event): the <form>'s action and method, _method overriding", async () => {
    const calls = stub(() => json(200, {}))
    const form = useForm({ title: 'x' })
    const element = (method: string, override?: string) => ({
      getAttribute: (name: string) => (name === 'action' ? '/todos/t1' : name === 'method' ? method : null),
      querySelector: () => (override ? { value: override } : null),
    })
    let prevented = false
    await form.submit({
      currentTarget: element('post', 'patch'),
      preventDefault: () => (prevented = true),
    } as unknown as Event)
    expect([calls[0]?.url, calls[0]?.init.method, prevented]).toEqual(['/todos/t1', 'PATCH', true])
    await form.submit('put', '/todos/t2')
    expect([calls[1]?.url, calls[1]?.init.method]).toEqual(['/todos/t2', 'PUT'])
    expect(() => form.submit({ currentTarget: null } as unknown as Event)).toThrow('needs the submit event of a <form>')
  })
})

describe('http', () => {
  test('get with a query string; post JSON; a result, never a throw', async () => {
    const calls = stub(() => json(200, [{ id: 1 }]))
    const list = await http.get<{ id: number }[]>('/api/todos', { page: 2, tags: ['a', 'b'] })
    expect(calls[0]?.url).toBe('/api/todos?page=2&tags=a&tags=b')
    expect(list).toMatchObject({ ok: true, status: 200, data: [{ id: 1 }] })
    stub(() => json(422, { errors: { title: ['Required.'] } }))
    expect(await http.post('/api/todos', { title: '' })).toMatchObject({
      ok: false,
      status: 422,
      errors: { title: 'Required.' },
    })
    stub(() => {
      throw new TypeError('offline')
    })
    expect(await http.delete('/api/todos/1')).toMatchObject({ ok: false, status: 0, error: 'offline' })
  })
})

describe('shared helpers', () => {
  test('buildUrl matches the server rules', () => {
    const routes = {
      'todos.toggle': { path: '/todos/:todo/toggle' },
      'ops.show': { path: '/', domain: ':operator.albastr.test' },
    }
    expect(buildUrl(routes, 'https://albastr.test', 'todos.toggle', { todo: 'a b', page: 2 })).toBe(
      '/todos/a%20b/toggle?page=2',
    )
    expect(buildUrl(routes, 'https://albastr.test', 'ops.show', { operator: 'mada' })).toBe(
      'https://mada.albastr.test/',
    )
    expect(() => buildUrl(routes, undefined, 'todos.toggle')).toThrow('needs parameter "todo"')
    expect(() => buildUrl(routes, undefined, 'nope')).toThrow('No route named "nope"')
  })

  test('formatters: money from minor units (exact), calendar dates, durations', () => {
    expect(formatMoneyIn('fr', '220000', 'EUR').replace(/[\u00a0\u202f]/g, ' ')).toBe('2 200,00 €')
    expect(formatMoneyIn('en', { amount: '123456789012345678901', currency: 'JPY' })).toBe(
      '¥123,456,789,012,345,678,901',
    )
    expect(formatDateIn('en', '2027-05-14', 'long')).toBe('May 14, 2027')
    expect(formatDurationIn('en', 150)).toBe('2h 30m')
  })

  test('defineStore on the server: fresh state per call (never shared between requests)', () => {
    const useCurrency = defineStore('currency', () => ({ code: 'EUR' }))
    const a = useCurrency()
    a.code = 'USD'
    expect(useCurrency().code).toBe('EUR')
  })
})
