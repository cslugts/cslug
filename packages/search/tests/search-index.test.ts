import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Application, ConsoleIO, Logger, runInContext } from '@cslug/core'
import { Database } from '@cslug/database'
import { SQL } from 'bun'
import { SEARCH_MIGRATIONS, SearchIndex, SearchReindexCommand, searchIndex } from '../src'
import { faqDocuments } from './fixture/app/search/faq-search-index'

const DATABASE_URL = process.env.DATABASE_URL
const FIXTURE = join(import.meta.dir, 'fixture')

test('searchIndex(): one definition per name; language names are checked', () => {
  searchIndex('unique-name')
  expect(() => searchIndex('unique-name')).toThrow("searchIndex('unique-name') is defined twice")
  expect(() => new SearchIndex('x', { languages: ["french'"] })).toThrow('Not a text search configuration')
  expect(new SearchIndex('y', { languages: ['french', 'english'] }).configs).toEqual(['cslug_french', 'cslug_english'])
  expect(new SearchIndex('z', { unaccent: false }).configs).toEqual(['simple'])
})

describe.skipIf(!DATABASE_URL)('SearchIndex against PostgreSQL', () => {
  const name = `cslug_search_index_${process.pid}`
  const admin = new SQL(Object.assign(new URL(DATABASE_URL as string), { pathname: '/postgres' }).toString(), {
    max: 1,
  })
  let db: Database
  let app: Application
  const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)
  const help = searchIndex<{ kind: string; url: string }>('help', { languages: ['french', 'english'] })

  beforeAll(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.unsafe(`create database "${name}"`)
    const url = Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString()
    db = new Database({ url, slowQueryMs: 10_000 }, Logger.null())
    for (const file of readdirSync(SEARCH_MIGRATIONS).sort())
      await db.pool.unsafe(readFileSync(join(SEARCH_MIGRATIONS, file), 'utf8').split('-- down')[0] as string)
    app = new Application({ root: FIXTURE }).instance(Database, db)
    await inApp(() =>
      help.upsertMany([
        {
          key: 'visa',
          title: 'Visa à l’arrivée',
          body: 'Le visa touristique coûte 35 €.',
          metadata: { kind: 'faq', url: '/visa' },
        },
        {
          key: 'vaccins',
          title: 'Vaccins',
          body: 'Aucun vaccin obligatoire, mais le visa…',
          metadata: { kind: 'faq', url: '/vaccins' },
        },
        {
          key: 'packing',
          title: 'What to pack',
          body: 'Light clothes, a <rain> jacket & boots',
          language: 'english',
          metadata: { kind: 'guide', url: '/pack' },
        },
      ]),
    )
  })
  afterAll(async () => {
    await db?.close()
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.close()
  })

  test('search: ranked (title before body), accents ignored, a page with the total', async () => {
    const page = await inApp(() => help.search('visa'))
    expect(page.data.map((h) => h.key)).toEqual(['visa', 'vaccins'])
    expect(page.meta).toEqual({ page: 1, perPage: 20, total: 2, lastPage: 1 })
    expect(page.data[0]).toMatchObject({
      key: 'visa',
      title: 'Visa à l’arrivée',
      metadata: { kind: 'faq', url: '/visa' },
    })
    expect(page.data[0]?.rank).toBeGreaterThan(page.data[1]?.rank as number)
    expect((await inApp(() => help.search('arrivee'))).data.map((h) => h.key)).toEqual(['visa'])
    expect((await inApp(() => help.search('visa', { perPage: 1, page: 2 }))).data.map((h) => h.key)).toEqual([
      'vaccins',
    ])
  })

  test('each document in its own language; filter on metadata; highlights escaped; typos', async () => {
    // english stems "packing" to "pack" (the title); french does not
    expect((await inApp(() => help.search('packing'))).data.map((h) => h.key)).toEqual(['packing'])
    expect((await inApp(() => help.search('packing', { language: 'french' }))).data).toEqual([])
    expect((await inApp(() => help.search('visa', { filter: { url: '/vaccins' } }))).data.map((h) => h.key)).toEqual([
      'vaccins',
    ])
    const [packing] = (await inApp(() => help.search('jacket', { highlight: { fragments: 0 } }))).data
    expect(packing?.highlight).toEqual({
      title: 'What to pack',
      body: 'Light clothes, a &lt;rain&gt; <mark>jacket</mark> &amp; boots',
    })
    expect((await inApp(() => help.search('vacins'))).data).toEqual([])
    expect((await inApp(() => help.search('vacins', { typos: true }))).data.map((h) => h.key)).toEqual(['vaccins'])
    expect(inApp(() => help.search('x', { language: 'german' }))).rejects.toThrow(
      '"german" is not a language of index help',
    )
  })

  test('upsert replaces by key; remove, count, clear; other indexes are untouched', async () => {
    const other = searchIndex('other')
    await inApp(async () => {
      await other.upsert({ key: 'visa', title: 'Not the same visa' })
      await help.upsert({
        key: 'visa',
        title: 'Visa électronique',
        body: 'En ligne',
        metadata: { kind: 'faq', url: '/evisa' },
      })
    })
    const [visa] = (await inApp(() => help.search('electronique'))).data
    expect(visa).toMatchObject({ key: 'visa', metadata: { url: '/evisa' } })
    expect(await inApp(() => help.count())).toBe(3)
    expect(await inApp(() => help.remove('visa', 'nope'))).toBe(1)
    expect(await inApp(() => help.clear())).toBe(2)
    expect(await inApp(() => other.count())).toBe(1)
    expect((await inApp(() => help.search(''))).meta.total).toBe(0)
  })

  test('cslug search:reindex: the indexes of app/search/ refilled from their source; stale documents removed', async () => {
    let out = ''
    app.instance(
      ConsoleIO,
      new (class extends ConsoleIO {
        override write(text: string) {
          out += text
        }
        override error(text: string) {
          out += text
        }
      })(),
    )
    const run = (args: Record<string, unknown>) =>
      inApp(async () => (new SearchReindexCommand() as unknown as { handle(a: unknown): Promise<number> }).handle(args))
    faqDocuments.push(
      { key: 'a', title: 'Baobabs', body: 'Allée des baobabs' },
      { key: 'b', title: 'Tsingy', body: 'Forêt de pierre' },
    )
    expect(await run({})).toBe(0)
    expect(out).toContain('faq: 2 indexed, 0 removed')
    faqDocuments.splice(0, 2, { key: 'b', title: 'Tsingy', body: 'Ponts suspendus' })
    await Bun.sleep(5)
    expect(await run({ index: 'faq' })).toBe(0)
    expect(out).toContain('faq: 1 indexed, 1 removed')
    const { faqIndex } = await import('./fixture/app/search/faq-search-index')
    expect((await inApp(() => faqIndex.search('ponts'))).data.map((h) => h.key)).toEqual(['b'])
    expect(await run({ index: 'nope' })).toBe(1)
    expect(out).toContain('No index "nope" in app/search/')
    expect(inApp(() => help.reindex())).rejects.toThrow('Index help has no documents() source')
  })
})
