/** Schemas for real-world values: money, currencies, countries, phone numbers, uploaded files. */
import { BigIntSchema } from './primitives'
import { type Ctx, INVALID, type Invalid, type JsonSchema, Schema } from './schema'

// ── currency (ISO 4217) ─────────────────────────────────────────────────────────────────────────────
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'))

export class CurrencySchema<const C extends string = string> extends Schema<C, string> {
  constructor(readonly only?: readonly C[]) {
    super({})
  }
  _run(value: unknown, ctx: Ctx): C | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
    const allowed = this.only
      ? (this.only as readonly string[]).includes(code)
      : /^[A-Z]{3}$/.test(code) && CURRENCIES.has(code)
    return allowed ? (code as C) : this._issue(ctx, 'currency', this.only ? { options: [...this.only] } : undefined)
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'string', ...(this.only ? { enum: [...this.only] } : { pattern: '^[A-Z]{3}$' }) })
  }
}

// ── money: { amount: bigint minor units, currency } ─────────────────────────────────────────────────
export type MoneyValue<C extends string = string> = { amount: bigint; currency: C }

export class MoneySchema<const C extends string = string> extends Schema<
  MoneyValue<C>,
  { amount: bigint | number | string; currency: string }
> {
  readonly amountSchema: BigIntSchema
  readonly currencySchema: CurrencySchema<C>

  constructor(options: { currencies?: readonly C[]; min?: bigint | number; max?: bigint | number } = {}) {
    super({})
    let amount = new BigIntSchema()
    if (options.min !== undefined) amount = amount.min(options.min)
    if (options.max !== undefined) amount = amount.max(options.max)
    this.amountSchema = amount
    this.currencySchema = new CurrencySchema<C>(options.currencies)
  }

  _run(value: unknown, ctx: Ctx): MoneyValue<C> | Invalid {
    if (value === undefined || value === null) return this._issue(ctx, 'required')
    if (typeof value !== 'object' || Array.isArray(value)) return this._issue(ctx, 'money')
    const v = value as Record<string, unknown>
    ctx.path.push('amount')
    const amount = this.amountSchema._parse(v.amount, ctx)
    ctx.path.pop()
    ctx.path.push('currency')
    const currency = this.currencySchema._parse(v.currency, ctx)
    ctx.path.pop()
    return amount === INVALID || currency === INVALID ? INVALID : { amount, currency }
  }

  _json(): JsonSchema {
    return this._jsonMeta({
      type: 'object',
      properties: { amount: this.amountSchema._json(), currency: this.currencySchema._json() },
      required: ['amount', 'currency'],
      additionalProperties: false,
      description: this._def.description ?? 'Amount in minor units (e.g. cents) and ISO 4217 currency',
    })
  }
}

// ── country (ISO 3166-1 alpha-2) ─────────────────────────────────────────────────────────────────────
const regions = new Intl.DisplayNames(['en'], { type: 'region' })
/** Codes Intl knows that are not ISO 3166-1 countries (exceptionally reserved, user-assigned, groupings). */
const NOT_COUNTRIES = new Set(['UK', 'EU', 'EZ', 'UN', 'ZZ', 'QO', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA'])

export class CountrySchema extends Schema<string> {
  _run(value: unknown, ctx: Ctx): string | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
    const known = /^[A-Z]{2}$/.test(code) && !NOT_COUNTRIES.has(code) && regions.of(code) !== code
    return known ? code : this._issue(ctx, 'country')
  }
  _json(): JsonSchema {
    return this._jsonMeta({ type: 'string', pattern: '^[A-Z]{2}$' })
  }
}

// ── phone (E.164) ────────────────────────────────────────────────────────────────────────────────────
/**
 * Calling codes for `defaultCountry`, with the national trunk prefix that is dropped ("0" in Madagascar and
 * France, none in Italy). Numbers in other countries must be written with "+".
 */
const CALLING: Record<string, { code: string; trunk: string | null }> = {
  MG: { code: '261', trunk: '0' },
  RE: { code: '262', trunk: '0' },
  YT: { code: '262', trunk: '0' },
  MU: { code: '230', trunk: null },
  KM: { code: '269', trunk: null },
  SC: { code: '248', trunk: null },
  MZ: { code: '258', trunk: null },
  ZA: { code: '27', trunk: '0' },
  KE: { code: '254', trunk: '0' },
  FR: { code: '33', trunk: '0' },
  BE: { code: '32', trunk: '0' },
  CH: { code: '41', trunk: '0' },
  DE: { code: '49', trunk: '0' },
  NL: { code: '31', trunk: '0' },
  ES: { code: '34', trunk: null },
  PT: { code: '351', trunk: null },
  IT: { code: '39', trunk: null },
  GB: { code: '44', trunk: '0' },
  IE: { code: '353', trunk: '0' },
  US: { code: '1', trunk: '1' },
  CA: { code: '1', trunk: '1' },
  AU: { code: '61', trunk: '0' },
  JP: { code: '81', trunk: '0' },
  CN: { code: '86', trunk: '0' },
  IN: { code: '91', trunk: '0' },
  KR: { code: '82', trunk: '0' },
}

export class PhoneSchema extends Schema<string> {
  readonly calling?: { code: string; trunk: string | null }

  constructor(readonly defaultCountry?: string) {
    super({})
    if (defaultCountry) {
      this.calling = CALLING[defaultCountry]
      if (!this.calling) {
        throw new Error(
          `v.phone(): no calling code known for "${defaultCountry}"; numbers must then be written with "+"`,
        )
      }
    }
  }
  _run(value: unknown, ctx: Ctx): string | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    if (typeof value !== 'string') return this._issue(ctx, 'phone')
    const raw = value.trim().replace(/[\s().-]/g, '')
    let e164: string | undefined
    if (/^\+\d+$/.test(raw)) e164 = raw
    else if (/^00\d+$/.test(raw)) e164 = `+${raw.slice(2)}`
    else if (/^\d+$/.test(raw) && this.calling) {
      const { code, trunk } = this.calling
      const national = trunk && raw.startsWith(trunk) ? raw.slice(trunk.length) : raw
      e164 = `+${code}${national}`
    }
    // E.164: at most 15 digits; 8 is a safe lower bound for real subscriber numbers
    return e164 && /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : this._issue(ctx, 'phone')
  }
  _json(): JsonSchema {
    return this._jsonMeta({
      type: 'string',
      pattern: '^\\+[1-9]\\d{7,14}$',
      description: this._def.description ?? 'E.164 phone number',
    })
  }
}

// ── uploaded file ───────────────────────────────────────────────────────────────────────────────────
const SIZE = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i
const UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }
export const parseSize = (size: string | number): number => {
  if (typeof size === 'number') return size
  const [, amount, unit] = SIZE.exec(size.trim()) ?? []
  const factor = unit ? UNITS[unit.toLowerCase()] : undefined
  if (!amount || !factor) throw new Error(`Invalid size "${size}" (use e.g. "10mb")`)
  return Math.round(Number(amount) * factor)
}

/** Magic numbers for the types we can recognise from the first bytes. */
const SIGNATURES: [type: string, test: (b: Uint8Array) => boolean][] = [
  ['application/pdf', (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  [
    'image/webp',
    (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45,
  ],
]

/** The type recognised from the bytes, or undefined if it is not one we can recognise. */
export async function sniffType(file: Blob): Promise<string | undefined> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  return SIGNATURES.find(([, test]) => test(head))?.[0]
}

/**
 * An uploaded file (a `File`/`Blob` from multipart form data). Size and declared type are checked by `parse()`;
 * when `types` lists types we can recognise, the **bytes** are checked too, which needs `parseAsync()`
 * (`request.validate()` always uses it).
 */
export class FileSchema extends Schema<File> {
  readonly maxBytes?: number
  readonly types?: readonly string[]

  constructor(options: { maxSize?: string | number; types?: readonly string[] } = {}) {
    super({})
    this.maxBytes = options.maxSize === undefined ? undefined : parseSize(options.maxSize)
    this.types = options.types
    const sniffable = options.types?.filter((t) => SIGNATURES.some(([s]) => s === t)) ?? []
    if (sniffable.length) {
      this._def.refines = [
        {
          check: async (file: File) => {
            const actual = await sniffType(file)
            return actual !== undefined && (options.types as readonly string[]).includes(actual)
          },
          message: 'validation.file.type',
          code: 'file.type',
          path: [],
          params: { types: [...(options.types ?? [])] },
          async: true,
        },
      ]
    }
  }

  _run(value: unknown, ctx: Ctx): File | Invalid {
    if (value === undefined || value === null || value === '') return this._issue(ctx, 'required')
    if (!(value instanceof Blob)) return this._issue(ctx, 'file')
    if (this.maxBytes !== undefined && value.size > this.maxBytes) {
      return this._issue(ctx, 'file.size', { max: formatSize(this.maxBytes) })
    }
    if (this.types && !this.types.includes(value.type)) return this._issue(ctx, 'file.type', { types: [...this.types] })
    return value as File
  }

  _json(): JsonSchema {
    return this._jsonMeta({
      type: 'string',
      contentEncoding: 'binary',
      ...(this.types ? { contentMediaType: this.types.join(', ') } : {}),
    })
  }
}

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${+(bytes / 1024 ** 2).toFixed(1)} MB`
    : bytes >= 1024
      ? `${+(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`
