import { describe, expect, test } from 'bun:test'
import { Clock, CslugError, FakeClock, Money, minorDigits, parseDuration } from '../src'

describe('parseDuration', () => {
  test('units and combinations', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('2d')).toBe(172_800_000)
    expect(parseDuration('1w')).toBe(604_800_000)
    expect(parseDuration(250)).toBe(250)
  })
  test('nonsense is an error, never a silent zero', () => {
    for (const bad of ['', '10', 'ten minutes', '5y', '1h junk', -1])
      expect(() => parseDuration(bad)).toThrow(CslugError)
  })
})

describe('Clock', () => {
  test('today in a time zone: 22:30 UTC on May 14 is already May 15 in Antananarivo (UTC+3)', () => {
    const clock = new FakeClock('Indian/Antananarivo', '2027-05-14T22:30:00Z')
    expect(clock.today()).toBe('2027-05-15')
    expect(clock.today(0, 'UTC')).toBe('2027-05-14')
    expect(clock.today(-3)).toBe('2027-05-12')
    expect(clock.today(20)).toBe('2027-06-04')
  })

  test('atLocal: 07:00 in Antananarivo is 04:00 UTC', () => {
    expect(new Clock('Indian/Antananarivo').atLocal('2027-05-14', '07:00').toISOString()).toBe(
      '2027-05-14T04:00:00.000Z',
    )
  })

  test('atLocal across daylight saving time (Paris)', () => {
    const paris = new Clock('Europe/Paris')
    expect(paris.atLocal('2027-01-15', '09:00').toISOString()).toBe('2027-01-15T08:00:00.000Z') // CET, UTC+1
    expect(paris.atLocal('2027-07-15', '09:00').toISOString()).toBe('2027-07-15T07:00:00.000Z') // CEST, UTC+2
    expect(paris.atLocal('2027-03-28', '03:30').toISOString()).toBe('2027-03-28T01:30:00.000Z') // the day DST starts
  })

  test('add / subtract', () => {
    const clock = new FakeClock('UTC', '2027-05-14T00:00:00Z')
    expect(clock.add('2h').toISOString()).toBe('2027-05-14T02:00:00.000Z')
    expect(clock.subtract('90d').toISOString()).toBe('2027-02-13T00:00:00.000Z')
  })

  test('FakeClock: frozen; travelTo, advance', () => {
    const clock = new FakeClock('UTC', '2027-05-14T00:00:00Z')
    expect(clock.now()).toEqual(clock.now())
    clock.advance('3d')
    expect(clock.today()).toBe('2027-05-17')
    clock.travelTo('2028-02-29T12:00:00Z')
    expect(clock.today()).toBe('2028-02-29')
    expect(() => clock.travelTo('not a date')).toThrow(CslugError)
  })

  test('unknown time zone fails loudly', () => {
    expect(() => new Clock('Mars/Olympus')).toThrow(/Unknown time zone "Mars\/Olympus"/)
  })
})

describe('Money', () => {
  test('of / from / toJSON / toString', () => {
    const m = Money.of('220000', 'eur')
    expect(m.amount).toBe(220000n)
    expect(m.currency).toBe('EUR')
    expect(Money.from({ amount: 220000n, currency: 'EUR' }).equals(m)).toBe(true)
    expect(JSON.stringify({ total: m })).toBe('{"total":{"amount":"220000","currency":"EUR"}}')
    expect(String(m)).toBe('EUR 2200.00')
    for (const bad of [12.5, '12.50', Number.NaN]) expect(() => Money.of(bad as never, 'EUR')).toThrow(/minor units/)
    expect(() => Money.of(1n, 'XXQ')).toThrow(/Unknown currency/)
  })

  test('the MVP unit economics: 8% commission on €2,200 = €176, less 2.5% and 1%', () => {
    const pkg = Money.of(220000n, 'EUR')
    const commission = pkg.percent(8)
    expect(commission.toDecimal()).toBe('176.00')
    const contribution = commission.subtract(pkg.percent(2.5)).subtract(pkg.percent(1))
    expect(contribution.toDecimal()).toBe('99.00')
  })

  test('rounding is half away from zero, to the minor unit', () => {
    expect(Money.of(1n, 'EUR').percent(50).amount).toBe(1n) // 0.5 → 1
    expect(Money.of(-1n, 'EUR').percent(50).amount).toBe(-1n) // -0.5 → -1
    expect(Money.of(3n, 'EUR').percent(10).amount).toBe(0n) // 0.3 → 0
    expect(Money.of(1000n, 'EUR').multiply('1.005').amount).toBe(1005n)
    expect(Money.of(999n, 'EUR').multiply(0.5).amount).toBe(500n)
  })

  test('allocate never loses a cent (staged escrow releases 30/40/30)', () => {
    const parts = Money.of(100001n, 'EUR').allocate([30, 40, 30])
    expect(parts.map((p) => p.amount)).toEqual([30001n, 40000n, 30000n])
    expect(Money.sum(parts).amount).toBe(100001n)
    expect(
      Money.of(10n, 'EUR')
        .allocate([1, 1, 1])
        .map((p) => p.amount),
    ).toEqual([4n, 3n, 3n])
    expect(
      Money.of(-10n, 'EUR')
        .allocate([1, 1, 1])
        .map((p) => p.amount),
    ).toEqual([-4n, -3n, -3n])
    expect(
      Money.of(5n, 'EUR')
        .allocate([0, 1])
        .map((p) => p.amount),
    ).toEqual([0n, 5n])
    expect(() => Money.of(5n, 'EUR').allocate([])).toThrow()
  })

  test('different currencies never mix', () => {
    expect(() => Money.of(1n, 'EUR').add(Money.of(1n, 'MGA'))).toThrow(/Cannot combine EUR and MGA/)
    expect(() => Money.of(1n, 'EUR').compare(Money.of(1n, 'USD'))).toThrow()
  })

  test('format per locale and currency digits, exact for huge amounts', () => {
    // French uses a narrow no-break space (U+202F) between thousands and a no-break space (U+00A0) before €
    expect(Money.of(220000n, 'EUR').format('fr')).toBe('2\u202f200,00\u00a0€')
    expect(Money.of(220000n, 'EUR').format('en')).toBe('€2,200.00')
    expect(Money.of(-1760n, 'EUR').format('it')).toBe('-17,60\u00a0€')
    expect(Money.of(1500n, 'JPY').toDecimal()).toBe('1500')
    expect(Money.of(1500n, 'KWD').toDecimal()).toBe('1.500')
    expect(Money.of(5n, 'EUR').toDecimal()).toBe('0.05')
    expect(Money.of(1234567890123456789n, 'EUR').format('en')).toBe('€12,345,678,901,234,567.89')
    expect([minorDigits('EUR'), minorDigits('JPY'), minorDigits('KWD')]).toEqual([2, 0, 3])
  })

  test('comparisons', () => {
    const a = Money.of(1n, 'EUR')
    const b = Money.of(2n, 'EUR')
    expect([a.compare(b), b.compare(a), a.compare(a)]).toEqual([-1, 1, 0])
    expect([Money.zero('EUR').isZero(), b.isPositive(), b.negate().isNegative()]).toEqual([true, true, true])
  })
})
