/**
 * The examples from guides/07-validation.md, guides/04-configuration.md and apps/starter-kit, as written there.
 * If one of these needs changing, the guide changes in the same PR.
 */
import { describe, expect, test } from 'bun:test'
import { configure, type Fail, Validator, v } from '../src'
import { assertType, type Equal, errorsOf, errorsOfAsync } from './type-helpers'

describe('guide 07: StoreTripRequestValidator', () => {
  configure({ today: () => '2027-01-10' })

  const StoreTripRequestValidator = v.object({
    circuitId: v.uuid(),
    startDate: v.date().future(),
    nights: v.int().min(3).max(30),
    groupSize: v.int().min(1).max(12),
    budget: v.money({ currencies: ['EUR', 'USD', 'GBP'] }),
    interests: v
      .array(v.enum(['wildlife', 'hiking', 'beach', 'culture', 'photography']))
      .max(5)
      .default([]),
    name: v.string().trim().min(2).max(120),
    email: v.email().toLowerCase(),
    whatsapp: v.phone().optional(),
    nationality: v.country(),
    message: v.string().max(2000).optional(),
  })
  type StoreTripRequest = v.infer<typeof StoreTripRequestValidator>

  const input = {
    circuitId: crypto.randomUUID(),
    startDate: '2027-05-14',
    nights: 10,
    groupSize: 2,
    budget: { amount: '400000', currency: 'EUR' },
    name: ' Giulia ',
    email: 'GIULIA@example.it',
    whatsapp: '+39 347 123 4567',
    nationality: 'it',
  }

  test('parses a real request', () => {
    const data = StoreTripRequestValidator.parse(input)
    expect(data).toMatchObject({
      budget: { amount: 400000n, currency: 'EUR' },
      interests: [],
      name: 'Giulia',
      email: 'giulia@example.it',
      whatsapp: '+393471234567',
      nationality: 'IT',
    })
  })

  test('the inferred type is what the guide promises', () => {
    assertType<Equal<StoreTripRequest['budget'], { amount: bigint; currency: 'EUR' | 'USD' | 'GBP' }>>()
    assertType<Equal<StoreTripRequest['interests'], ('wildlife' | 'hiking' | 'beach' | 'culture' | 'photography')[]>>()
    assertType<Equal<StoreTripRequest['whatsapp'], string | undefined>>()
    assertType<Equal<StoreTripRequest['startDate'], string>>()
  })

  test('group size over 12 is rejected with the int.max key', () => {
    expect(errorsOf(() => StoreTripRequestValidator.parse({ ...input, groupSize: 20 }))).toEqual({
      groupSize: ['validation.int.max'],
    })
  })

  test('JSON Schema export works on the whole request', () => {
    const schema = StoreTripRequestValidator.toJSONSchema() as { required: string[] }
    expect(schema.required).toEqual([
      'circuitId',
      'startDate',
      'nights',
      'groupSize',
      'budget',
      'name',
      'email',
      'nationality',
    ])
  })
})

describe('guide 07: RegisterOperatorValidator (Validator class with DI and after())', () => {
  class OperatorRepository {
    async existsBy(where: { email?: string; licenceNumber?: string }) {
      return where.email === 'taken@example.test' || where.licenceNumber === 'LIC-1'
    }
  }

  class RegisterOperatorValidator extends Validator {
    constructor(private operators: OperatorRepository) {
      super()
    }

    schema = v.object({
      companyName: v.string().min(2),
      registrationNumber: v.string().regex(/^\d{5}\s?\d{2}\s?\d{4}\s?\d\s?\d{5}$/),
      licenceNumber: v.string(),
      email: v.email(),
      phone: v.phone({ defaultCountry: 'MG' }),
      payout: v.object({ method: v.enum(['mvola', 'orange_money', 'airtel_money', 'bank']), account: v.string() }),
    })

    async after(data: v.infer<this['schema']>, fail: Fail) {
      if (await this.operators.existsBy({ email: data.email })) fail('email', 'validation.unique')
      if (await this.operators.existsBy({ licenceNumber: data.licenceNumber }))
        fail('licenceNumber', 'operators.licence_taken')
    }
  }

  const valid = {
    companyName: 'Ravinala Tours',
    registrationNumber: '12345 67 8901 2 34567',
    licenceNumber: 'LIC-9',
    email: 'hello@ravinala.test',
    phone: '034 12 345 67',
    payout: { method: 'mvola', account: '0341234567' },
  }

  test('valid input passes, phone normalised for Madagascar', async () => {
    const data = await new RegisterOperatorValidator(new OperatorRepository()).validate(valid)
    expect(data.phone).toBe('+261341234567')
  })

  test('after() reports database checks with custom keys', async () => {
    const errors = await errorsOfAsync(() =>
      new RegisterOperatorValidator(new OperatorRepository()).validate({
        ...valid,
        email: 'taken@example.test',
        licenceNumber: 'LIC-1',
      }),
    )
    expect(errors).toEqual({ email: ['validation.unique'], licenceNumber: ['operators.licence_taken'] })
  })
})

describe('guide 07: upload validator', () => {
  test('UploadLicenceValidator', async () => {
    configure({ today: () => '2027-01-10' })
    const UploadLicenceValidator = v.object({
      document: v.file({ maxSize: '10mb', types: ['application/pdf', 'image/jpeg', 'image/png'] }),
      expiresOn: v.date().future(),
    })
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'licence.pdf', { type: 'application/pdf' })
    expect((await UploadLicenceValidator.parseAsync({ document: pdf, expiresOn: '2028-01-01' })).document.name).toBe(
      'licence.pdf',
    )
  })
})

describe('starter kit validators', () => {
  const TodoPriority = ['low', 'normal', 'high'] as const
  const StoreTodoValidator = v.object({
    title: v.string().trim().min(1).max(200),
    notes: v.string().trim().max(2000).optional(),
    priority: v.enum(TodoPriority).default('normal'),
    dueOn: v.date().optional(),
  })
  const UpdateTodoValidator = StoreTodoValidator.partial()
  const LoginValidator = v.object({
    email: v.email().toLowerCase(),
    password: v.string().min(1),
    remember: v.coerce.boolean().default(false),
  })

  test('store, update (partial), login with an unchecked "remember" checkbox', () => {
    expect(StoreTodoValidator.parse({ title: 'Buy bread' })).toEqual({ title: 'Buy bread', priority: 'normal' })
    expect(UpdateTodoValidator.parse({ priority: 'high' })).toEqual({ priority: 'high' })
    expect(LoginValidator.parse({ email: 'A@B.TEST', password: 'x' })).toEqual({
      email: 'a@b.test',
      password: 'x',
      remember: false,
    })
    expect(LoginValidator.parse({ email: 'a@b.test', password: 'x', remember: 'on' }).remember).toBe(true)
  })

  test('v.input<> is what a form holds (guide 08 useForm typing)', () => {
    assertType<
      Equal<
        v.input<typeof StoreTodoValidator>,
        {
          title: string
          notes?: string | undefined
          priority?: 'low' | 'normal' | 'high' | undefined
          dueOn?: string | undefined
        }
      >
    >()
  })

  test('RegisterValidator: password confirmation via refine', () => {
    const schema = v
      .object({
        name: v.string().trim().min(2).max(80),
        email: v.email().toLowerCase(),
        password: v.string().min(12).max(200),
        passwordConfirmation: v.string(),
      })
      .refine((d) => d.password === d.passwordConfirmation, {
        path: ['passwordConfirmation'],
        message: 'auth.password_mismatch',
      })
    const errors = errorsOf(() =>
      schema.parse({
        name: 'Ada',
        email: 'ada@x.test',
        password: 'correct horse battery',
        passwordConfirmation: 'nope',
      }),
    )
    expect(errors).toEqual({ passwordConfirmation: ['auth.password_mismatch'] })
  })
})

describe('guide 04: env schema fields', () => {
  test('string env values are coerced and validated', () => {
    const env = v.object({
      APP_ENV: v.enum(['development', 'test', 'staging', 'production']).default('development'),
      APP_URL: v.url(),
      APP_KEY: v.secret().min(32),
      REDIS_URL: v.url().default('redis://localhost:6379'),
      SMTP_PORT: v.coerce.int().default(1025),
      ANTHROPIC_API_KEY: v.secret().optional(),
    })
    expect(
      env.extend({ DATABASE_URL: v.url() }).parse({
        APP_URL: 'https://example.com',
        APP_KEY: 'k'.repeat(32),
        DATABASE_URL: 'postgres://cslug:secret@db:5432/demo',
        REDIS_URL: 'redis://cache:6379',
      }).DATABASE_URL,
    ).toBe('postgres://cslug:secret@db:5432/demo')
    const parsed = env.parse({ APP_URL: 'http://localhost:3000', APP_KEY: 'k'.repeat(32), SMTP_PORT: '2525' })
    expect(parsed).toEqual({
      APP_ENV: 'development',
      APP_URL: 'http://localhost:3000',
      APP_KEY: 'k'.repeat(32),
      REDIS_URL: 'redis://localhost:6379',
      SMTP_PORT: 2525,
    })
    expect(errorsOf(() => env.parse({ APP_URL: 'nope', APP_KEY: 'short' }))).toEqual({
      APP_URL: ['validation.url'],
      APP_KEY: ['validation.string.min'],
    })
  })
})
