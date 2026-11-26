import { afterEach, describe, expect, test } from 'bun:test'
import { v as validation } from '@cslug/validation'
import {
  AppError,
  Application,
  Clock,
  type ConfigPath,
  type ConfigValue,
  ConflictError,
  defineConfig,
  defineEnv,
  EnvError,
  ForbiddenError,
  inject,
  NotFoundError,
  secretKeys,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  v,
} from '../src'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <_T extends true>() => {}

// ── guide 04, as written ──────────────────────────────────────────────────────────────────────────
const envShape = {
  APP_ENV: v.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_URL: v.url(),
  APP_KEY: v.secret().min(32),
  DATABASE_URL: v.url(),
  REDIS_URL: v.url().default('redis://localhost:6379'),
  PAYMENTS_DRIVER: v.enum(['mangopay', 'fake']).default('fake'),
  MANGOPAY_API_KEY: v.secret().optional(),
}
const good = {
  APP_URL: 'https://albastr.com',
  APP_KEY: 'k'.repeat(32),
  DATABASE_URL: 'postgres://cslug:secret@db:5432/albastr',
}

describe('defineEnv', () => {
  test('valid env: typed, defaults applied, frozen', () => {
    const env = defineEnv(envShape, good)
    expect(env.PAYMENTS_DRIVER).toBe('fake')
    expect(env.REDIS_URL).toBe('redis://localhost:6379')
    expect(Object.isFrozen(env)).toBe(true)
    assertType<Equal<typeof env.PAYMENTS_DRIVER, 'mangopay' | 'fake'>>()
    assertType<Equal<typeof env.MANGOPAY_API_KEY, string | undefined>>()
  })

  test('every problem listed at once, with a hint, and no secret value printed', () => {
    const error = (() => {
      try {
        defineEnv(envShape, { APP_URL: 'https://albastr.com', APP_KEY: 'too-short-secret' })
      } catch (e) {
        return e as EnvError
      }
    })()
    expect(error).toBeInstanceOf(EnvError)
    expect(error?.message).toBe(
      [
        '✖ Invalid environment',
        '  APP_KEY        must be at least 32 characters',
        '  DATABASE_URL   is required',
        '  Run `cslug key:generate` to create APP_KEY.',
      ].join('\n'),
    )
    expect(error?.message).not.toContain('too-short-secret')
  })

  test('empty values (FOO=) count as missing', () => {
    expect(() => defineEnv(envShape, { ...good, DATABASE_URL: '  ' })).toThrow(/DATABASE_URL\s+is required/)
    expect(defineEnv(envShape, { ...good, MANGOPAY_API_KEY: '' }).MANGOPAY_API_KEY).toBeUndefined()
  })

  test('secret keys are known, for redaction', () => {
    expect(secretKeys(envShape)).toEqual(['APP_KEY', 'MANGOPAY_API_KEY'])
  })

  test('v from @cslug/core is the validation package', () => {
    expect(v).toBe(validation)
  })
})

// ── config files and config() ──────────────────────────────────────────────────────────────────────
const env = defineEnv(envShape, good)
const payments = defineConfig({
  driver: env.PAYMENTS_DRIVER,
  commissionPercent: 8,
  stages: [30, 40, 30],
  mangopay: { apiKey: env.MANGOPAY_API_KEY, baseUrl: 'https://api.sandbox.mangopay.com' },
})
const app = defineConfig({ name: 'Albastr', timezone: 'Indian/Antananarivo' })
const configs = { app, payments }
type Configs = typeof configs

describe('config', () => {
  let application: Application | undefined
  afterEach(async () => {
    await application?.shutdown()
    application = undefined
  })

  test('typed paths and values (what `declare module` gives config())', () => {
    assertType<Equal<ConfigValue<Configs, 'payments.commissionPercent'>, number>>()
    assertType<Equal<ConfigValue<Configs, 'payments.stages'>, number[]>>()
    assertType<Equal<ConfigValue<Configs, 'payments.driver'>, 'mangopay' | 'fake'>>()
    assertType<Equal<ConfigValue<Configs, 'payments.mangopay.baseUrl'>, string>>()
    type P = ConfigPath<Configs>
    assertType<Equal<'payments.mangopay.apiKey' extends P ? true : false, true>>()
    assertType<Equal<'payments.stages.0' extends P ? true : false, false>>() // arrays are leaves
    assertType<Equal<'payments.nope' extends P ? true : false, false>>()
  })

  test('app.config(path), sections, overrides before start, frozen after', async () => {
    application = new Application({ configs })
    expect(application.config('payments.commissionPercent')).toBe(8)
    expect(application.config('payments')).toBe(payments)
    application.setConfig('payments.driver', 'mangopay')
    expect(application.config('payments.driver')).toBe('mangopay')
    expect(payments.driver).toBe('fake') // the original file object is untouched
    await application.start()
    expect(() => application?.setConfig('payments.driver', 'fake')).toThrow(/read-only after start/)
    expect(Object.isFrozen(application.config('payments.mangopay'))).toBe(true)
  })

  test('the Clock follows config app.timezone; v.date().future() follows the Clock', async () => {
    application = new Application({ configs })
    expect(application.resolve(Clock).timezone).toBe('Indian/Antananarivo')
    await application.start()
    const tomorrow = application.resolve(Clock).today(1)
    expect(v.date().future().parse(tomorrow)).toBe(tomorrow)
    expect(() => v.date().future().parse(application?.resolve(Clock).today())).toThrow(ValidationError)
  })

  test('the Clock is injectable', () => {
    @inject(Clock)
    class Reminders {
      constructor(readonly clock: Clock) {}
    }
    expect(new Application().resolve(Reminders).clock.timezone).toBe('UTC')
  })
})

describe('typed errors', () => {
  test('status, code (= translation key) and params', () => {
    const nf = new NotFoundError('booking', 'b1')
    expect([nf.status, nf.code, nf.message, nf.params]).toEqual([
      404,
      'booking.not_found',
      'Booking b1 not found',
      { resource: 'booking', id: 'b1' },
    ])
    const conflict = new ConflictError('booking.invalid_transition', { from: 'accepted', to: 'completed' })
    expect([conflict.status, conflict.code, conflict.params]).toEqual([
      409,
      'booking.invalid_transition',
      { from: 'accepted', to: 'completed' },
    ])
    expect(new ForbiddenError('operators.not_verified').status).toBe(403)
    expect(new UnauthorizedError().code).toBe('auth.unauthenticated')
    expect(new TooManyRequestsError(30).params).toEqual({ retryAfter: 30 })
    expect(nf).toBeInstanceOf(AppError)
  })

  test('apps extend AppError for domain errors', () => {
    class EscrowReleaseRefused extends AppError {
      constructor(bookingId: string) {
        super('escrow.release_refused', `Release refused for ${bookingId}`, { status: 422, params: { bookingId } })
      }
    }
    const e = new EscrowReleaseRefused('b9')
    expect([e.name, e.status, e.code]).toEqual(['EscrowReleaseRefused', 422, 'escrow.release_refused'])
  })
})
