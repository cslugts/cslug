import { afterAll, describe, expect, test } from 'bun:test'
import { testApp } from '@cslug/testing'
import { v } from '@cslug/validation'
import { signWebhook, WebhookInbox } from '../src'
import { fixtureApp } from './fixture/app'

const hasDb = !!process.env.DATABASE_URL

describe.skipIf(!hasDb)('webhooks (guide 17)', () => {
  let drop = async () => {}
  const t = testApp({
    async create() {
      const f = await fixtureApp()
      drop = f.drop
      return f.app
    },
    database: 'truncate', // concurrent requests commit for real
  })
  afterAll(async () => {
    await drop()
  })

  const event = (id: string, amount = 12_000) => ({ id, type: 'hold.succeeded', amount })
  const sign = (body: unknown) => signWebhook('payments', JSON.stringify(body))
  const post = (body: ReturnType<typeof event>, headers: Record<string, string>) =>
    t.post('/webhooks/payments').headers(headers).json(body)

  test('a correctly signed event is accepted and stored', async () => {
    const first = event('evt_1')
    await post(first, await sign(first))
      .assertOk()
      .assertJson({ received: true, fresh: true })
    await t.assertDatabaseHas('cslug_webhook_inbox', { source: 'payments', externalId: 'evt_1' })
    await t.assertDatabaseHas('ledger', { eventId: 'evt_1', amount: 12_000 })
  })

  test('acceptance: the same event delivered 10 times (concurrently) has one effect', async () => {
    const body = event('evt_10x')
    const headers = await sign(body)
    const responses = await Promise.all(Array.from({ length: 10 }, () => post(body, headers).assertOk()))
    const fresh = await Promise.all(responses.map(async (r) => (await r.json<{ fresh: boolean }>()).fresh))
    expect(fresh.filter(Boolean)).toHaveLength(1)
    expect(await t.db.count('ledger', { eventId: 'evt_10x' })).toBe(1)
    expect(await t.db.count('cslug_webhook_inbox', { externalId: 'evt_10x' })).toBe(1)
  })

  test('401 on a missing, wrong or tampered signature; nothing stored', async () => {
    const body = event('evt_bad')
    await post(body, {}).assertProblem(401, 'webhook.bad_signature')
    await post(body, { 'X-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }).assertStatus(401)
    const signedOther = await signWebhook('payments', JSON.stringify(event('evt_bad', 1)))
    await post(body, signedOther).assertStatus(401) // signature of a different body
    expect(await t.db.count('cslug_webhook_inbox', { externalId: 'evt_bad' })).toBe(0)
  })

  test('tolerance: an old timestamp is rejected (replay of a captured request)', async () => {
    const body = event('evt_old')
    t.clock.travelTo('2027-05-14T08:00:00Z')
    const old = await signWebhook('payments', JSON.stringify(body), {
      timestamp: Date.parse('2027-05-14T07:50:00Z') / 1000,
    })
    await post(body, old).assertStatus(401)
    const recent = await signWebhook('payments', JSON.stringify(body), {
      timestamp: Date.parse('2027-05-14T07:57:00Z') / 1000,
    })
    await post(body, recent).assertOk()
  })

  test('other formats (sha256=…) and a custom check function', async () => {
    const body = JSON.stringify({ entry: [] })
    await t
      .post('/webhooks/whatsapp')
      .headers(await signWebhook('whatsapp', body))
      .json({ entry: [] })
      .assertOk()
    expect(Object.keys(await signWebhook('whatsapp', body))).toEqual(['X-Hub-Signature-256'])
    expect(Object.values(await signWebhook('whatsapp', body))[0]).toMatch(/^sha256=[0-9a-f]{64}$/)
    await t.post('/webhooks/whatsapp').header('X-Hub-Signature-256', 'sha256=abc').json({ entry: [] }).assertStatus(401)
    await t.post('/webhooks/custom').header('x-token', 'let-me-in').json({}).assertOk()
    await t.post('/webhooks/custom').json({}).assertStatus(401)
  })

  test('payload() validates; a processor runs on receive and on replay; prune()', async () => {
    const inbox = t.resolve(WebhookInbox)
    const seen: string[] = []
    inbox.process('sms', (id) => {
      seen.push(id)
    })
    expect(await inbox.receive('sms', 'sms_1', { status: 'delivered' })).toBe(true)
    expect(await inbox.receive('sms', 'sms_1', { status: 'delivered' })).toBe(false)
    expect(seen).toEqual(['sms_1'])

    expect(await inbox.payload('sms', 'sms_1', v.object({ status: v.string() }))).toEqual({ status: 'delivered' })
    await expect(inbox.payload('sms', 'sms_1', v.object({ status: v.number() }))).rejects.toThrow()
    await expect(inbox.payload('sms', 'nope')).rejects.toThrow(/No sms webhook event nope/)

    await inbox.replay('sms', 'sms_1')
    expect(seen).toEqual(['sms_1', 'sms_1'])
    await expect(inbox.replay('payments-without-processor', 'x')).rejects.toThrow(/No processor/)

    t.clock.travelTo(new Date(Date.now() + 100 * 86_400_000))
    expect(await inbox.prune('90d', 'sms')).toBe(1)
    expect(await inbox.receive('sms', 'sms_1', {})).toBe(true) // pruned: a new delivery is processed again
  })
})
