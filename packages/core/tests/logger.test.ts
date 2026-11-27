import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('Logger targets (M11)', () => {
  const saved = { level: process.env.LOG_LEVEL, format: process.env.LOG_FORMAT, role: process.env.CSLUG_ROLE }
  afterEach(() => {
    for (const [k, v] of [
      ['LOG_LEVEL', saved.level],
      ['LOG_FORMAT', saved.format],
      ['CSLUG_ROLE', saved.role],
    ] as const)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  })

  test('several targets, each with its own level and format', () => {
    const all: string[] = []
    const errors: string[] = []
    const log = new Logger({
      level: 'debug',
      targets: [
        { type: 'custom', write: (l) => all.push(l) },
        { type: 'custom', level: 'error', format: 'pretty', write: (l) => errors.push(l) },
      ],
    })
    log.debug('cache warm')
    log.error('payout failed', { bookingId: 'b1' })
    expect(all.map((l) => JSON.parse(l).msg)).toEqual(['cache warm', 'payout failed'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/ERROR payout failed {2}bookingId=b1$/)
  })

  test('file target: appends lines, one file per day with {date}, old days pruned to `keep`; children share it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cslug-logs-'))
    mkdirSync(dir, { recursive: true })
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) writeFileSync(join(dir, `app-${day}.log`), 'old\n')
    writeFileSync(join(dir, 'other.txt'), 'kept') // not a log of this target
    const log = new Logger({ targets: [{ type: 'file', path: join(dir, 'app-{date}.log'), keep: 2 }] })
    log.info('first')
    log.child({ area: 'admin' }).info('second')
    const today = `app-${new Date().toISOString().slice(0, 10)}.log`
    expect(readdirSync(dir).sort()).toEqual(['app-2026-01-03.log', today, 'other.txt'])
    const lines = readFileSync(join(dir, today), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => [l.msg, l.area])).toEqual([
      ['first', undefined],
      ['second', 'admin'],
    ])
    const plain = new Logger({ targets: [{ type: 'file', path: join(dir, 'nested/app.log') }] })
    plain.warn('no date')
    expect(existsSync(join(dir, 'nested/app.log'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test('LOG_LEVEL and LOG_FORMAT when the config does not say; the config wins', () => {
    process.env.LOG_LEVEL = 'WARN'
    process.env.LOG_FORMAT = 'pretty'
    const lines: string[] = []
    const fromEnv = new Logger({ targets: [{ type: 'custom', write: (l) => lines.push(l) }] })
    fromEnv.info('hidden')
    fromEnv.warn('shown')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('WARN  shown')
    const configured = new Logger({ level: 'debug', format: 'json', write: (l) => lines.push(l) })
    configured.debug('json')
    expect(JSON.parse(lines[1] as string).msg).toBe('json')
    process.env.LOG_LEVEL = 'nonsense'
    expect(new Logger().isEnabled('info')).toBe(true)
  })

  test('the context adds originRequestId, traceId and spanId; the app binds the process role', async () => {
    const { log, entries } = capture()
    runInContext(
      {
        app: new Application(),
        scope: new Application().createScope(),
        requestId: 'job:j1',
        originRequestId: 'r1',
        traceId: 't1',
        spanId: 's1',
      },
      () => log.info('in a job'),
    )
    expect(entries()[0]).toMatchObject({ requestId: 'job:j1', originRequestId: 'r1', traceId: 't1', spanId: 's1' })

    process.env.CSLUG_ROLE = 'worker'
    const lines: string[] = []
    const app = new Application({ configs: { log: { write: (l: string) => lines.push(l) } } })
    await app.start()
    app.resolve(Logger).info('up')
    expect(JSON.parse(lines[0] as string)).toMatchObject({ msg: 'up', role: 'worker' })
    await app.shutdown()
  })
})
