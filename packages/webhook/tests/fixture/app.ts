/** The webhook test app: two signed sources, an inbox route whose effect is a ledger row. */
import { Application, inject, Logger } from '@cslug/core'
import { Database, DatabaseProvider, sql } from '@cslug/database'
import { type HttpContext, HttpKernel, HttpProvider, Router } from '@cslug/http'
import { SQL } from 'bun'
import { verifySignature, WebhookInbox, WebhookProvider } from '../../src'

type PaymentEvent = { id: string; type: string; amount: number }

@inject(WebhookInbox, Database)
export class PaymentWebhookController {
  constructor(
    private inbox: WebhookInbox,
    private db: Database,
  ) {}

  async handle({ request }: HttpContext) {
    const event = (await request.body()) as PaymentEvent
    const fresh = await this.inbox.receive('payments', event.id, event, () =>
      this.db.exec(sql`insert into ledger (event_id, amount) values (${event.id}, ${event.amount})`),
    )
    return { received: true, fresh }
  }
}

const routes = (r: Parameters<Router['load']>[0] extends (r: infer R) => void ? R : never) => {
  r.post('/webhooks/payments', [PaymentWebhookController, 'handle']).middleware(verifySignature('payments'))
  r.post('/webhooks/whatsapp', () => ({ ok: true })).middleware(verifySignature('whatsapp'))
  r.post('/webhooks/custom', () => ({ ok: true })).middleware(
    verifySignature((req) => req.header('x-token') === 'let-me-in'),
  )
}

export const WEBHOOKS = {
  payments: {
    secret: 'whsec_test',
    header: 'X-Signature',
    algorithm: 'sha256',
    format: 't={timestamp},v1={signature}',
    tolerance: '5m',
  },
  whatsapp: { secret: 'app-secret', header: 'X-Hub-Signature-256', format: 'sha256={signature}' },
}

/** A throwaway database (from DATABASE_URL) and the app on it. */
export async function fixtureApp() {
  const url = process.env.DATABASE_URL as string
  const name = `cslug_webhook_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).toString(), { max: 1 })
  await admin.unsafe(`create database "${name}"`)
  const app = new Application({
    root: import.meta.dir,
    configs: {
      app: { env: 'test' },
      database: { url: Object.assign(new URL(url), { pathname: `/${name}` }).toString() },
      webhooks: WEBHOOKS,
    },
  })
  app.useProviders([DatabaseProvider, WebhookProvider, HttpProvider])
  app.singleton(Logger, () => Logger.null())
  const start = app.start.bind(app)
  app.start = async (...a) => {
    const s = await start(...a)
    s.resolve(Router).load(routes, { middleware: [] })
    s.resolve(HttpKernel).compile()
    return s
  }
  return {
    app,
    drop: async () => {
      await admin.unsafe(`drop database if exists "${name}" with (force)`)
      await admin.close()
    },
  }
}
