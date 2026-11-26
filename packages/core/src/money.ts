import { CslugError } from './errors'

const digitsCache = new Map<string, number>()
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'))

/** Minor-unit digits of a currency, from Intl (EUR 2, JPY 0, KWD 3). */
export function minorDigits(currency: string): number {
  let d = digitsCache.get(currency)
  if (d === undefined) {
    // Intl.NumberFormat accepts any well-formed code, so check against the real list first
    if (!CURRENCIES.has(currency)) throw new CslugError('money.invalid_currency', `Unknown currency "${currency}"`)
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      throw new CslugError('money.invalid_currency', `Unknown currency "${currency}"`)
    }
    digitsCache.set(currency, d)
  }
  return d
}

/** n / d rounded half away from zero (commercial rounding). */
function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d
  const r = n % d
  if (r === 0n) return q
  const twice = (r < 0n ? -r : r) * 2n
  return twice >= (d < 0n ? -d : d) ? q + (n < 0n !== d < 0n ? -1n : 1n) : q
}

/** A decimal number (`8`, `2.5`, `'12.75'`) as an exact fraction. */
function toFraction(value: number | string): { num: bigint; den: bigint } {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : 'x') : value.trim()
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.includes('e') ? Number(text).toFixed(20).replace(/0+$/, '') : text)
  if (!m) throw new CslugError('money.invalid_number', `Not a decimal number: ${value}`)
  const decimals = m[3] ?? ''
  const num = BigInt(`${m[1]}${m[2]}${decimals}`)
  return { num, den: 10n ** BigInt(decimals.length) }
}

/**
 * An amount of money: integer **minor units** (cents) and an ISO 4217 currency. Immutable; arithmetic never uses
 * floating point. `Money.of(220000n, 'EUR')` is €2,200.00.
 */
export class Money {
  private constructor(
    readonly amount: bigint,
    readonly currency: string,
  ) {}

  /** From minor units: a bigint, a safe integer or a digit string. */
  static of(amount: bigint | number | string, currency: string): Money {
    let a: bigint
    if (typeof amount === 'bigint') a = amount
    else if (typeof amount === 'number' && Number.isSafeInteger(amount)) a = BigInt(amount)
    else if (typeof amount === 'string' && /^-?\d+$/.test(amount.trim())) a = BigInt(amount.trim())
    else
      throw new CslugError('money.invalid_amount', `Money amounts are integers in minor units, got ${String(amount)}`)
    const c = currency.trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(c)) throw new CslugError('money.invalid_currency', `Unknown currency "${currency}"`)
    minorDigits(c) // validates with Intl
    return new Money(a, c)
  }

  /** From what `v.money()` returns, or a row's `{ amount, currency }`. */
  static from(value: { amount: bigint | number | string; currency: string }): Money {
    return Money.of(value.amount, value.currency)
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency)
  }

  /** Sum of several amounts in the same currency. */
  static sum(items: readonly Money[], currency?: string): Money {
    const first = items[0]
    const start = Money.zero(currency ?? first?.currency ?? 'EUR')
    return items.reduce((total, m) => total.add(m), start)
  }

  private same(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CslugError('money.currency_mismatch', `Cannot combine ${this.currency} and ${other.currency}`)
    }
  }

  add(other: Money): Money {
    this.same(other)
    return new Money(this.amount + other.amount, this.currency)
  }

  subtract(other: Money): Money {
    this.same(other)
    return new Money(this.amount - other.amount, this.currency)
  }

  /** Multiply by a decimal factor, rounded half away from zero to the minor unit. */
  multiply(factor: number | string | bigint): Money {
    if (typeof factor === 'bigint') return new Money(this.amount * factor, this.currency)
    const { num, den } = toFraction(factor)
    return new Money(roundDiv(this.amount * num, den), this.currency)
  }

  /** A percentage, rounded half away from zero: `Money.of(220000n, 'EUR').percent(8)` → €176.00. */
  percent(percent: number | string): Money {
    const { num, den } = toFraction(percent)
    return new Money(roundDiv(this.amount * num, den * 100n), this.currency)
  }

  /**
   * Split by ratios without losing a cent: `allocate([30, 40, 30])`. The remainder goes one minor unit at a time to
   * the first shares, so the parts always add up to the total.
   */
  allocate(ratios: readonly number[]): Money[] {
    if (!ratios.length || ratios.some((r) => !Number.isInteger(r) || r < 0) || ratios.every((r) => r === 0)) {
      throw new CslugError('money.invalid_ratios', 'allocate() needs non-negative integer ratios, not all zero')
    }
    const total = BigInt(ratios.reduce((a, b) => a + b, 0))
    const parts = ratios.map((r) => (this.amount * BigInt(r)) / total)
    let remainder = this.amount - parts.reduce((a, b) => a + b, 0n)
    const step = remainder < 0n ? -1n : 1n
    for (let i = 0; remainder !== 0n; i = (i + 1) % parts.length) {
      if (ratios[i] === 0) continue
      parts[i] = (parts[i] as bigint) + step
      remainder -= step
    }
    return parts.map((p) => new Money(p, this.currency))
  }

  negate(): Money {
    return new Money(-this.amount, this.currency)
  }

  isZero(): boolean {
    return this.amount === 0n
  }
  isPositive(): boolean {
    return this.amount > 0n
  }
  isNegative(): boolean {
    return this.amount < 0n
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount
  }

  /** -1, 0 or 1. Throws on different currencies. */
  compare(other: Money): -1 | 0 | 1 {
    this.same(other)
    return this.amount < other.amount ? -1 : this.amount > other.amount ? 1 : 0
  }

  /** Exact decimal string in major units: `'2200.00'`. */
  toDecimal(): string {
    const digits = minorDigits(this.currency)
    const negative = this.amount < 0n
    const abs = (negative ? -this.amount : this.amount).toString().padStart(digits + 1, '0')
    const major = digits ? `${abs.slice(0, -digits)}.${abs.slice(-digits)}` : abs
    return negative ? `-${major}` : major
  }

  /** Localised: `format('fr')` → `2 200,00 €`. Exact for any size (formats the decimal string). */
  format(locale = 'en', options: Omit<Intl.NumberFormatOptions, 'style' | 'currency'> = {}): string {
    const f = new Intl.NumberFormat(locale, { ...options, style: 'currency', currency: this.currency })
    return f.format(this.toDecimal() as unknown as number)
  }

  /** JSON has no bigint: `{ amount: "220000", currency: "EUR" }`. */
  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount.toString(), currency: this.currency }
  }

  toString(): string {
    return `${this.currency} ${this.toDecimal()}`
  }
}
