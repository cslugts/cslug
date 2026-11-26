import { describe, expect, test } from 'bun:test'
import { parseSize, sniffType, v } from '../src'
import { assertType, type Equal, errorsOf, errorsOfAsync } from './type-helpers'

describe('money and currency', () => {
  test('money: amount as bigint minor units + ISO currency, upper-cased', () => {
    expect(v.money().parse({ amount: '220000', currency: 'eur' })).toEqual({ amount: 220000n, currency: 'EUR' })
    expect(errorsOf(() => v.money().parse({ amount: '12.5', currency: 'EUR' }))).toEqual({
      amount: ['validation.invalid_type'],
    })
    expect(errorsOf(() => v.money().parse({ amount: 1, currency: 'ABC' }))).toEqual({
      currency: ['validation.currency'],
    })
    expect(errorsOf(() => v.money().parse(100))).toEqual({ '': ['validation.money'] })
  })

  test('restricted currencies are typed', () => {
    const Budget = v.money({ currencies: ['EUR', 'USD', 'GBP'] })
    expect(errorsOf(() => Budget.parse({ amount: 1, currency: 'MGA' }))).toEqual({ currency: ['validation.currency'] })
    assertType<Equal<v.infer<typeof Budget>, { amount: bigint; currency: 'EUR' | 'USD' | 'GBP' }>>()
  })

  test('min amount', () => {
    expect(errorsOf(() => v.money({ min: 1 }).parse({ amount: 0, currency: 'EUR' }))).toEqual({
      amount: ['validation.bigint.min'],
    })
  })

  test('currency on its own; MGA is valid', () => {
    expect(v.currency().parse('mga')).toBe('MGA')
  })
})

describe('country', () => {
  test('ISO 3166-1 alpha-2, normalised; groupings and reserved codes rejected', () => {
    expect(v.country().parse('mg')).toBe('MG')
    expect(v.country().parse('IT')).toBe('IT')
    for (const bad of ['UK', 'EU', 'ZZ', 'XY', 'MDG', '1A'])
      expect(errorsOf(() => v.country().parse(bad))).toEqual({ '': ['validation.country'] })
  })
})

describe('phone', () => {
  test('E.164 input, any separators', () => {
    expect(v.phone().parse('+261 34 12 345 67')).toBe('+261341234567')
    expect(v.phone().parse('0033 6 12 34 56 78')).toBe('+33612345678')
    expect(errorsOf(() => v.phone().parse('034 12 345 67'))).toEqual({ '': ['validation.phone'] })
  })

  test('national numbers with defaultCountry; trunk prefix per country', () => {
    expect(v.phone({ defaultCountry: 'MG' }).parse('034 12 345 67')).toBe('+261341234567')
    expect(v.phone({ defaultCountry: 'FR' }).parse('06 12 34 56 78')).toBe('+33612345678')
    expect(v.phone({ defaultCountry: 'IT' }).parse('06 1234 5678')).toBe('+390612345678') // Italy keeps the 0
  })

  test('too short / too long; unknown defaultCountry fails at definition', () => {
    expect(errorsOf(() => v.phone().parse('+2613'))).toEqual({ '': ['validation.phone'] })
    expect(errorsOf(() => v.phone().parse('+1234567890123456'))).toEqual({ '': ['validation.phone'] })
    expect(() => v.phone({ defaultCountry: 'XX' })).toThrow(/no calling code/)
  })
})

describe('file', () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  test('parseSize', () => {
    expect(parseSize('10mb')).toBe(10 * 1024 * 1024)
    expect(parseSize('1.5 KB')).toBe(1536)
    expect(() => parseSize('ten')).toThrow()
  })

  test('size and declared type checked synchronously', () => {
    const Doc = v.file({ maxSize: '4b' })
    expect(errorsOf(() => Doc.parse(new File([pdfBytes], 'a.pdf', { type: 'application/pdf' })))).toEqual({
      '': ['validation.file.size'],
    })
    expect(errorsOf(() => v.file().parse('not a file'))).toEqual({ '': ['validation.file'] })
  })

  test('the type is checked from the BYTES, not the client-declared type (parseAsync)', async () => {
    const Licence = v.file({ maxSize: '10mb', types: ['application/pdf', 'image/png'] })
    const real = new File([pdfBytes], 'licence.pdf', { type: 'application/pdf' })
    expect(await Licence.parseAsync(real)).toBe(real)
    const disguised = new File([new TextEncoder().encode('<?php evil')], 'licence.pdf', { type: 'application/pdf' })
    expect(await errorsOfAsync(() => Licence.parseAsync(disguised))).toEqual({ '': ['validation.file.type'] })
    expect(await sniffType(new Blob([pngBytes]))).toBe('image/png')
  })

  test('sync parse() refuses schemas that need byte sniffing', () => {
    const Licence = v.file({ types: ['application/pdf'] })
    expect(() => Licence.parse(new File([pdfBytes], 'a.pdf', { type: 'application/pdf' }))).toThrow(/parseAsync/)
  })
})
