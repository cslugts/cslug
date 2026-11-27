import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Application, inject, Logger, runInContext } from '@cslug/core'
import {
  boolean,
  Database,
  diffSchemas,
  id,
  introspect,
  migrationSql,
  Repository,
  table,
  tableSpec,
  text,
} from '@cslug/database'
import { SQL } from 'bun'
import { SEARCH_MIGRATIONS, search, searchable } from '../src'

const circuits = table(
  'circuits',
  {
    id: id(),
    title: text(),
    summary: text().nullable(),
    body: text().nullable(),
    published: boolean().default(true),
    search: searchable({ title: 'A', summary: 'B', body: 'C' }, { language: 'french' }),
  },
  { indexes: (t) => [t.using('gin', 'search'), t.using('gin', ['title', 'gin_trgm_ops'])] },
)

const pages = table(
  'pages',
  {
    id: id(),
    locale: text(),
    title: text(),
    body: text(),
    search: searchable(
      { title: 'A', body: 'B' },
      { language: { column: 'locale', configs: { fr: 'french', en: 'english', it: 'italian' } } },
    ),
  },
  { indexes: (t) => [t.using('gin', 'search')] },
)

const plain = table('plain', { id: id(), name: text() })

test('searchable(): a hidden, generated, weighted tsvector; accent-insensitive configurations by default', () => {
  expect(circuits.columns.search.def.hidden).toBe(true)
  const fixed = circuits.generatedSql.get('search') as string
  expect(fixed).toBe(
    "setweight(to_tsvector('cslug_french', coalesce(\"title\", '')), 'A') || " +
      "setweight(to_tsvector('cslug_french', coalesce(\"summary\", '')), 'B') || " +
      "setweight(to_tsvector('cslug_french', coalesce(\"body\", '')), 'C')",
  )
  const perRow = pages.generatedSql.get('search') as string
  expect(perRow).toStartWith(`case "locale" when 'fr' then setweight(to_tsvector('cslug_french'`)
  expect(perRow).toContain(`else setweight(to_tsvector('cslug_simple'`)
  const raw = table('raw', { a: text(), s: searchable({ a: 'A' }, { language: 'english', unaccent: false }) })
  expect(raw.generatedSql.get('s')).toBe(`setweight(to_tsvector('english', coalesce("a", '')), 'A')`)
  expect(() => searchable({ a: 'E' as never })).toThrow('Search weights are A, B, C or D')
  expect(() => searchable({ a: 'A' }, { language: "french'; drop" })).toThrow('Not a text search configuration')
})

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('search() against PostgreSQL', () => {
  const name = `cslug_search_${process.pid}`
  const admin = new SQL(Object.assign(new URL(DATABASE_URL as string), { pathname: '/postgres' }).toString(), {
    max: 1,
  })
  let db: Database
  let app: Application

  @inject()
  class CircuitRepository extends Repository(circuits) {}
  @inject()
  class PageRepository extends Repository(pages) {}
  const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)
  let repo: CircuitRepository

  beforeAll(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.unsafe(`create database "${name}"`)
    const url = Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString()
    db = new Database({ url, slowQueryMs: 10_000 }, Logger.null())
    const migration = readFileSync(join(SEARCH_MIGRATIONS, '00000000_000600_cslug_search.sql'), 'utf8')
    await db.pool.unsafe(migration.split('-- down')[0] as string)
    const [up] = migrationSql(diffSchemas([circuits, pages, plain].map(tableSpec), [])).split('-- down')
    await db.pool.unsafe(up as string)
    app = new Application().instance(Database, db)
    repo = app.createScope().resolve(CircuitRepository)
    await inApp(async () => {
      await repo.create({
        title: 'Isalo en 4x4',
        summary: 'Canyons et piscines naturelles',
        body: 'Des éléphants de pierre, des lémuriens',
      })
      await repo.create({ title: 'Tsingy du Bemaraha', summary: 'Forêt de pierre', body: 'Ponts suspendus, 4x4' })
      await repo.create({
        title: 'Allée des baobabs',
        summary: null,
        body: 'Coucher de soleil <b>inoubliable</b> & "photos"',
      })
      await repo.create({ title: 'Isalo à pied', body: 'Randonnées sans voiture', published: false })
    })
  })
  afterAll(async () => {
    await db?.close()
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.close()
  })

  const titles = (rows: { title: string }[]) => rows.map((r) => r.title)

  test('the differ sees no drift: the generated vector and its gin index read back as declared', async () => {
    expect(diffSchemas([circuits, pages, plain].map(tableSpec), await introspect(db))).toEqual([])
  })

  test('ranked: a title match (A) before a body match (C); stems and accents are ignored', async () => {
    const found = await inApp(() => search(repo, '4x4').all())
    expect(titles(found)).toEqual(['Isalo en 4x4', 'Tsingy du Bemaraha'])
    expect(found[0]?.rank).toBeGreaterThan(found[1]?.rank as number)
    expect(found.every((r) => r.rank > 0 && r.rank < 1)).toBe(true)
    expect(titles(await inApp(() => search(repo, 'elephant lemurien').all()))).toEqual(['Isalo en 4x4']) // éléphants
    expect(titles(await inApp(() => search(repo, 'FORET').all()))).toEqual(['Tsingy du Bemaraha']) // Forêt
  })

  test('web-search syntax: "phrases", -exclusions and or', async () => {
    expect(titles(await inApp(() => search(repo, '"forêt de pierre"').all()))).toEqual(['Tsingy du Bemaraha'])
    expect(titles(await inApp(() => search(repo, 'isalo -voiture').all()))).toEqual(['Isalo en 4x4'])
    expect((await inApp(() => search(repo, 'baobab or tsingy').all())).length).toBe(2)
  })

  test('a query: where, paginate and later orderBy compose; the vector never shows in rows', async () => {
    const page = await inApp(() => search(repo, 'isalo').where({ published: true }).paginate(1, 10))
    expect(page.meta.total).toBe(1)
    expect('search' in (page.data[0] as object)).toBe(false)
    const both = await inApp(() => search(repo.where({}), 'isalo').orderBy('title').all())
    expect(both.length).toBe(2)
  })

  test('highlights: matching words in <mark>, the text HTML-escaped first', async () => {
    const [isalo] = await inApp(() => search(repo, 'elephants', { highlight: ['body'] }).all())
    // fragments start at a word that is not a stop word ("Des" is dropped)
    expect(isalo?.highlight.body).toBe('<mark>éléphants</mark> de pierre, des lémuriens')
    const [whole] = await inApp(() =>
      search(repo, 'elephants', { highlight: { columns: ['body'], fragments: 0 } }).all(),
    )
    expect(whole?.highlight.body).toBe('Des <mark>éléphants</mark> de pierre, des lémuriens')
    const [baobab] = await inApp(() => search(repo, 'soleil', { highlight: { columns: ['body', 'summary'] } }).all())
    expect(baobab?.highlight.body).toBe(
      'Coucher de <mark>soleil</mark> &lt;b&gt;inoubliable&lt;/b&gt; &amp; &quot;photos', // entities stay whole
    )
    expect(baobab?.highlight.summary).toBe('')
  })

  test('typos: word similarity on trigram-indexed columns finds near misses, ranked lower', async () => {
    expect(await inApp(() => search(repo, 'isallo').all())).toEqual([])
    const found = await inApp(() =>
      search(repo, 'isallo', { typos: ['title'] })
        .where({ published: true })
        .all(),
    )
    expect(titles(found)).toEqual(['Isalo en 4x4'])
    const exact = await inApp(() =>
      search(repo, 'isalo', { typos: ['title'] })
        .where({ published: true })
        .all(),
    )
    expect((exact[0]?.rank ?? 0) > (found[0]?.rank ?? 0)).toBe(true)
  })

  test('a language per row: each row stemmed in its own language; `language` narrows the query', async () => {
    const pagesRepo = app.createScope().resolve(PageRepository)
    await inApp(async () => {
      await pagesRepo.create({ locale: 'fr', title: 'Randonnées', body: 'Les plus belles randonnées' })
      await pagesRepo.create({ locale: 'en', title: 'Hiking', body: 'The best hikes in the park' })
      await pagesRepo.create({ locale: 'it', title: 'Escursioni', body: 'Le escursioni più belle' })
      await pagesRepo.create({ locale: 'mg', title: 'Dia an-tongotra', body: 'Lalana' })
    })
    expect(titles(await inApp(() => search(pagesRepo, 'randonnee').all()))).toEqual(['Randonnées'])
    expect(titles(await inApp(() => search(pagesRepo, 'hike').all()))).toEqual(['Hiking'])
    expect(titles(await inApp(() => search(pagesRepo, 'escursione').all()))).toEqual(['Escursioni'])
    expect(titles(await inApp(() => search(pagesRepo, 'lalana').all()))).toEqual(['Dia an-tongotra']) // fallback
    expect(await inApp(() => search(pagesRepo, 'hike', { language: 'fr' }).all())).toEqual([])
    const [en] = await inApp(() => search(pagesRepo, 'hikes', { language: 'english', highlight: ['body'] }).all())
    expect(en?.highlight.body).toBe('best <mark>hikes</mark> in the park')
    expect(() => search(pagesRepo, 'x', { language: 'de' })).toThrow('"de" is not a language of this search column')
  })

  test('a blank term filters nothing (rank 0); a table without searchable() says so', async () => {
    const all = await inApp(() => search(repo, '  ').all())
    expect(all.length).toBe(4)
    expect(all.every((r) => r.rank === 0)).toBe(true)
    expect(() => search(app.createScope().resolve(CircuitRepository).query(), 'x', { column: 'title' })).toThrow(
      'circuits has no searchable() column named "title"',
    )
    @inject()
    class PlainRepository extends Repository(plain) {}
    expect(() => search(app.createScope().resolve(PlainRepository), 'x')).toThrow('plain has no searchable() column')
  })
})
