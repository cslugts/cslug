import { afterEach, describe, expect, test } from 'bun:test'
import { defineStore, useForm } from '../src'
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
