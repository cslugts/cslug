import { describe, expect, test } from 'bun:test'
import { QueueProvider } from '@cslug/queue'
import { RedisProvider } from '@cslug/redis'
import { testApp } from '@cslug/testing'
import { type ArrayTransport, Mailer } from '../src'
import { mailApp, TodoDueMail } from './support'

const REDIS_URL = process.env.REDIS_URL

describe.skipIf(!REDIS_URL)('queued mail through @cslug/queue', () => {
  const t = testApp({
    create: () =>
      mailApp(
        {
          redis: { connections: { default: { url: REDIS_URL } }, prefix: `cslug-mailtest:${process.pid}:` },
          mail: {
            from: { address: 'hello@starter.test' },
            transport: 'array',
            transports: { array: {} },
            queue: 'mail',
          },
        },
        [RedisProvider, QueueProvider],
      ),
    fakes: ['queue'],
  })

  test('rendered now, pushed as the job cslug.mail on mail.queue, sent by the worker', async () => {
    await t.resolve(Mailer).to('ada@example.test').locale('fr').send(TodoDueMail.preview())
    const [job] = t.queue?.pushed ?? []
    expect(job?.job.jobName).toBe('cslug.mail')
    expect(job?.queue).toBe('mail')
    const transport = t.resolve(Mailer).transport as ArrayTransport
    expect(transport.messages).toHaveLength(0)
    await t.queue?.drain()
    expect(transport.messages.map((m) => [m.to[0]?.address, m.subject])).toEqual([
      ['ada@example.test', '2 tâches arrivent à échéance'],
    ])
  })
})
