import { describe, expect, test } from 'bun:test'
import { testApp } from '@cslug/testing'
import { Mailer } from '../src'
import { mailApp, TodoDueMail } from './support'

/** Mailpit (docker compose: SMTP :1025, API :8025); CI runs it as a service. */
const MAILPIT_URL = process.env.MAILPIT_URL

describe.skipIf(!MAILPIT_URL)('acceptance: the reminder email reaches Mailpit over SMTP', () => {
  const t = testApp({
    create: () =>
      mailApp({
        mail: {
          from: { address: 'hello@starter.test', name: 'Starter Kit' },
          transport: 'smtp',
          transports: {
            smtp: { host: process.env.SMTP_HOST ?? 'localhost', port: Number(process.env.SMTP_PORT ?? 1025) },
          },
        },
      }),
  })

  test('sent with the SMTP client, received with the subject, inlined CSS and a text part', async () => {
    const to = `ada-${Date.now()}@example.test`
    await t.resolve(Mailer).to({ email: to, name: 'Ada' }).sendNow(TodoDueMail.preview())
    let found: { ID: string; Subject: string } | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)
      found = ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages[0]
      if (!found) await Bun.sleep(100)
    }
    expect(found?.Subject).toBe('2 todos are due')
    const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${found?.ID}`)).json()) as {
      HTML: string
      Text: string
      From: { Address: string; Name: string }
    }
    expect(message.From).toMatchObject({ Address: 'hello@starter.test', Name: 'Starter Kit' })
    expect(message.HTML).toContain('style="padding: 16px; color: #0f766e"')
    expect(message.Text).toContain('Hello Ada')
    expect(message.Text).toContain('- Pay the deposit')
  })
})
