import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { v } from '@cslug/validation'
import {
  Application,
  formatDate,
  formatMoney,
  Money,
  runInContext,
  Translator,
  t,
  tr,
  validationTranslator,
  withLocale,
} from '../src'

const starterKitLang = join(import.meta.dir, '../../../apps/starter-kit/resources/lang')

// guide 16's French file
const fr = {
  bookings: {
    created: 'Votre demande a bien été reçue.',
    pay: { title: 'Acompte pour {ref}', cta: "Payer l'acompte en sécurité" },
    travellers: '{count, plural, one {# voyageur} other {# voyageurs}}',
  },
  validation: { 'int.max': 'Doit être au plus {max}.' },
}
const en = {
  bookings: {
    created: 'We received your request.',
    travellers: '{count, plural, =0 {no travellers} one {# traveller} other {# travellers}}',
  },
  greeting: '{gender, select, female {Welcome, Madame {name}} male {Welcome, Monsieur {name}} other {Welcome, {name}}}',
}

const translator = new Translator(
  { locales: ['fr', 'en', 'it'], default: 'en', fallback: { it: 'en', fr: 'en' } },
  { fr, en },
)

describe('Translator', () => {
  test('arguments, nested keys, ICU plural with # and =N, select', () => {
    expect(translator.translate('bookings.pay.title', { ref: 'ALB-7K2Q9F' }, 'fr')).toBe('Acompte pour ALB-7K2Q9F')
    expect(translator.translate('bookings.travellers', { count: 1 }, 'fr')).toBe('1 voyageur')
    expect(translator.translate('bookings.travellers', { count: 3 }, 'fr')).toBe('3 voyageurs')
    expect(translator.translate('bookings.travellers', { count: 0 }, 'en')).toBe('no travellers')
    expect(translator.translate('bookings.travellers', { count: 1200 }, 'en')).toBe('1,200 travellers')
    expect(translator.translate('greeting', { gender: 'female', name: 'Rova' }, 'en')).toBe('Welcome, Madame Rova')
    expect(translator.translate('greeting', { gender: 'x', name: 'Rova' }, 'en')).toBe('Welcome, Rova')
  })

  test('fallback chain: it → en; missing everywhere → undefined', () => {
    expect(translator.chain('it')).toEqual(['it', 'en'])
    expect(translator.translate('bookings.created', {}, 'it')).toBe('We received your request.')
    expect(translator.translate('nope', {}, 'fr')).toBeUndefined()
    expect(translator.has('bookings.created', 'it')).toBe(true)
  })

  test("loads the starter kit's lang files (en.json, fr.json) with their plurals", () => {
    const kit = Translator.fromDirectory(starterKitLang, { default: 'en', locales: ['en', 'fr'] })
    expect(kit.translate('todos.overdue', { count: 2 }, 'fr')).toBe('2 en retard')
    expect(kit.translate('mail.todo_due.subject', { count: 1 }, 'en')).toBe('A todo is due')
    expect(kit.translate('mail.todo_due.subject', { count: 3 }, 'en')).toBe('3 todos are due')
    expect(kit.translate('auth.welcome', { name: 'Ada' }, 'fr')).toBe('Bienvenue, Ada !')
    expect(kit.keys('fr').length).toBeGreaterThan(30)
  })

  test('namespaced files: resources/lang/fr/circuits.json → circuits.*', async () => {
    const dir = join(import.meta.dir, '.tmp-lang')
    await Bun.write(join(dir, 'fr.json'), JSON.stringify({ common: { yes: 'Oui' } }))
    await Bun.write(join(dir, 'fr/circuits.json'), JSON.stringify({ title: 'Circuits' }))
    const loaded = Translator.fromDirectory(dir, { default: 'fr' })
    expect([loaded.translate('common.yes'), loaded.translate('circuits.title')]).toEqual(['Oui', 'Circuits'])
    await Bun.$`rm -rf ${dir}`
  })
})

describe('t(), withLocale, tr, formatting', () => {
  const app = new Application({ configs: { app: { timezone: 'Indian/Antananarivo' } } }).instance(
    Translator,
    translator,
  )
  const inLocale = <T>(locale: string, fn: () => T) => runInContext({ app, scope: app, locale }, fn)

  test('t() uses the context locale; explicit locale wins; missing key returns the key', () => {
    expect(inLocale('fr', () => t('bookings.created'))).toBe('Votre demande a bien été reçue.')
    expect(inLocale('fr', () => t('bookings.created', {}, 'en'))).toBe('We received your request.')
    expect(inLocale('fr', () => t('bookings.unknown'))).toBe('bookings.unknown')
  })

  test('withLocale switches for a block (mail to a recipient)', () => {
    expect(inLocale('fr', () => withLocale('en', () => t('bookings.created')))).toBe('We received your request.')
  })

  test('tr() picks translated content with the fallback chain', () => {
    const title = { fr: 'Tana – Isalo', en: 'Tana to Isalo' }
    expect(inLocale('fr', () => tr(title))).toBe('Tana – Isalo')
    expect(inLocale('it', () => tr(title))).toBe('Tana to Isalo') // it → en
    expect(inLocale('fr', () => tr(null))).toBe('')
  })

  test('validation messages in the current locale', () => {
    const r = v.object({ groupSize: v.int().max(12) }).safeParse({ groupSize: 20 })
    if (r.success) throw new Error('expected failure')
    expect(inLocale('fr', () => r.error.messages(validationTranslator()))).toEqual({
      groupSize: ['Doit être au plus 12.'],
    })
    expect(inLocale('it', () => r.error.messages(validationTranslator()))).toEqual({
      groupSize: ['Must be at most 12.'],
    }) // built-in English
  })

  test('formatMoney and formatDate (calendar dates as is, instants in the app time zone)', () => {
    expect(inLocale('en', () => formatMoney(220000n, 'EUR'))).toBe('€2,200.00')
    expect(inLocale('fr', () => formatMoney(Money.of(220000n, 'EUR')))).toBe('2 200,00 €')
    expect(inLocale('fr', () => formatDate('2027-05-14', 'long'))).toBe('14 mai 2027')
    expect(inLocale('en', () => formatDate(new Date('2027-05-14T22:30:00Z'), 'long'))).toBe('May 15, 2027') // UTC+3
    expect(inLocale('en', () => formatDate(new Date('2027-05-14T22:30:00Z'), 'long', { tz: 'UTC' }))).toBe(
      'May 14, 2027',
    )
  })
})
