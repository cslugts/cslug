import { describe, expect, test } from 'bun:test'
import { Application, Logger, Money, NotFoundError, runInContext } from '../src'

const capture = (options: ConstructorParameters<typeof Logger>[0] = {}) => {
  const lines: string[] = []
  const log = new Logger({ ...options, write: (l) => lines.push(l) })
  return { log, lines, entries: () => lines.map((l) => JSON.parse(l)) }
}

describe('Logger', () => {
  test('one JSON line per entry: time, level, msg, fields', () => {
    const { log, entries } = capture()
    log.info('booking confirmed', { bookingId: 'b1', groupSize: 2 })
    const [e] = entries()
    expect(e).toMatchObject({ level: 'info', msg: 'booking confirmed', bookingId: 'b1', groupSize: 2 })
    expect(new Date(e.time).toString()).not.toBe('Invalid Date')
  })

  test('levels: below the minimum is dropped', () => {
    const { log, entries } = capture({ level: 'warn' })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(entries().map((e) => e.level)).toEqual(['warn', 'error'])
    expect(log.isEnabled('info')).toBe(false)
  })

  test('sensitive keys are redacted, at any depth, case-insensitively', () => {
    const { log, entries } = capture({ redact: ['MANGOPAY_API_KEY'] })
    log.info('login', {
      email: 'ada@example.test',
      password: 'hunter2',
      headers: { Authorization: 'Bearer abc', 'x-request-id': 'r1' },
      user: { passwordHash: '$argon2…', name: 'Ada' },
      config: { MANGOPAY_API_KEY: 'sk_live', accessToken: 't' },
    })
    expect(entries()[0]).toMatchObject({
      email: 'ada@example.test',
      password: '[redacted]',
      headers: { Authorization: '[redacted]', 'x-request-id': 'r1' },
      user: { passwordHash: '[redacted]', name: 'Ada' },
      config: { MANGOPAY_API_KEY: '[redacted]', accessToken: '[redacted]' },
    })
    expect(JSON.stringify(entries())).not.toContain('hunter2')
  })

  test('bigint, Date, Money, errors (with code and cause) and cycles serialise safely', () => {
    const { log, entries } = capture()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    log.error('release failed', {
      amount: 220000n,
      at: new Date('2027-05-14T04:00:00Z'),
      total: Money.of(220000n, 'EUR'),
      error: new Error('gateway timeout', { cause: new NotFoundError('booking', 'b1') }),
      cyclic,
    })
    const e = entries()[0]
    expect(e.amount).toBe('220000')
    expect(e.at).toBe('2027-05-14T04:00:00.000Z')
    expect(e.total).toEqual({ amount: '220000', currency: 'EUR' })
    expect(e.error).toMatchObject({
      name: 'Error',
      message: 'gateway timeout',
      cause: { name: 'NotFoundError', code: 'booking.not_found', status: 404 },
    })
    expect(e.error.stack).toContain('gateway timeout')
    expect(e.cyclic).toEqual({ name: 'loop', self: '[circular]' })
  })

  test('child() adds fields; the ambient context adds requestId, jobId and userId', () => {
    const { log, entries } = capture()
    const app = new Application()
    runInContext({ app, scope: app.createScope(), requestId: 'req-1', userId: 'u-9' }, () => {
      log.child({ area: 'admin' }).warn('operator suspended', { operatorId: 'op1' })
    })
    expect(entries()[0]).toMatchObject({ requestId: 'req-1', userId: 'u-9', area: 'admin', operatorId: 'op1' })
  })

  test('pretty format for terminals', () => {
    const { log, lines } = capture({ format: 'pretty' })
    log.info('server started', { port: 3000 })
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} INFO {2}server started {2}port=3000$/)
  })

  test('Logger.null() writes nothing; the app binds a Logger from config("log")', () => {
    Logger.null().error('nothing')
    const app = new Application({ configs: { log: { level: 'error' } } })
    expect(app.resolve(Logger).isEnabled('warn')).toBe(false)
  })
})
