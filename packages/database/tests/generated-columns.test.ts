import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Application, inject, runInContext } from '@cslug/core'
import {
  custom,
  type Database,
  diffSchemas,
  id,
  integer,
  introspect,
  migrationSql,
  numeric,
  Repository,
  type Row,
  sql,
  type Table,
  table,
  tableSpec,
  text,
} from '../src'
import { Database as Db } from '../src/database'
import { describeDb, testDatabase } from './support'

const vector = (c: (key: string) => string, weights: [string, string][]) =>
  weights.map(([key, w]) => `setweight(to_tsvector('simple', coalesce(${c(key)}, '')), '${w}')`).join(' || ')

/** A table with a computed total (visible) and a search vector (hidden), and gin indexes. */
const products = table(
  'products',
  {
    id: id(),
    name: text(),
    notes: text().nullable(),
    price: numeric(10, 2),
    qty: integer().default(1),
    total: numeric(12, 2).generatedAs((c) => `${c('price')} * ${c('qty')}`),
    search: custom('tsvector')
      .generatedAs((c) =>
        vector(c, [
          ['name', 'A'],
          ['notes', 'B'],
        ]),
      )
      .hidden(),
  },
  { indexes: (t) => [t.using('gin', 'search'), t.using('gin', ['name', 'gin_trgm_ops'])] },
)

test('the table: generated columns resolve sibling names; indexes with a method and operator classes', () => {
  expect(products.generatedSql.get('total')).toBe('"price" * "qty"')
  expect(products.indexes.map((i) => [i.name, i.using, i.ops])).toEqual([
    ['products_search_gin_idx', 'gin', undefined],
    ['products_name_gin_idx', 'gin', ['gin_trgm_ops']],
  ])
  const sql = migrationSql(diffSchemas([tableSpec(products)], []))
  expect(sql).toContain('  total numeric(12,2) generated always as ("price" * "qty") stored not null,')
  expect(sql).toContain("comment on column products.total is 'cslug:generated ")
  expect(sql).toContain('create index products_search_gin_idx on products using gin (search);')
  expect(sql).toContain('create index products_name_gin_idx on products using gin (name gin_trgm_ops);')
  expect(() => table('bad', { a: text(), b: text().generatedAs((c) => c('missing')) })).toThrow(
    'bad.b: generatedAs() refers to an unknown column "missing"',
  )
})

describeDb('generated and hidden columns against PostgreSQL', () => {
  let t: Awaited<ReturnType<typeof testDatabase>>
  let db: Database
  let app: Application
  beforeAll(async () => {
    t = await testDatabase()
    db = t.db
    await db.pool.unsafe('create extension if not exists pg_trgm')
    app = new Application().instance(Db, db)
  })
  afterAll(() => t?.drop())

  const apply = async (migration: string, part: 'up' | 'down') => {
    const [up, down] = migration.split('-- down')
    await db.pool.unsafe((part === 'up' ? up : down)?.replace('-- up', '') ?? '')
  }
  const drift = async (tables: Table[]) => diffSchemas(tables.map(tableSpec), await introspect(db))

  test('created by the differ, then no drift: generated expressions and gin indexes read back', async () => {
    await apply(migrationSql(await drift([products])), 'up')
    expect(await drift([products])).toEqual([])
  })

  @inject()
  class ProductRepository extends Repository(products) {}
  const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)

  test('writes leave generated columns out; rows show the visible ones and never the hidden ones', async () => {
    const repo = app.createScope().resolve(ProductRepository)
    const lamp = await inApp(() => repo.create({ name: 'Rice lamp', notes: 'hand made', price: '12.50', qty: 2 }))
    expect(lamp.total).toBe('25.00')
    expect('search' in lamp).toBe(false)
    // a whole row passed back (total included) still updates: generated values are not written
    const updated = await inApp(() => repo.update(lamp.id, { ...lamp, qty: 3 }))
    expect(updated.total).toBe('37.50')
    const listed = await inApp(() => repo.query().all())
    expect(Object.keys(listed[0] as object).sort()).toEqual(['id', 'name', 'notes', 'price', 'qty', 'total'])
    // the type agrees: `search` is not part of Row
    const key: keyof Row<typeof products> = 'total'
    expect(key).toBe('total')
  })

  test('whereSql + selectSql + orderBySql: a ranked search that still paginates', async () => {
    const repo = app.createScope().resolve(ProductRepository)
    await inApp(async () => {
      await repo.create({ name: 'Baobab print', notes: 'lamp shade pattern', price: '30.00' })
      await repo.create({ name: 'Lamp oil', price: '4.00' })
    })
    const q = sql`websearch_to_tsquery('simple', ${'lamp'})`
    const page = await inApp(() =>
      repo
        .query()
        .whereSql(sql`${products.c.search} @@ ${q}`)
        .selectSql('rank', sql<number>`ts_rank_cd(${products.c.search}, ${q})`)
        .orderBySql(sql`ts_rank_cd(${products.c.search}, ${q}) desc`)
        .orderBy('name')
        .paginate(1, 2),
    )
    expect(page.meta.total).toBe(3)
    expect(page.data.map((p) => p.name)).toEqual(['Lamp oil', 'Rice lamp']) // name matches (A) before notes (B)
    expect(typeof page.data[0]?.rank).toBe('number')
    expect((page.data[0]?.rank ?? 0) > 0).toBe(true)
  })

  test('a changed expression is set in place (and reverted by down); switching to generated drops and re-adds', async () => {
    const v2 = table(
      'products',
      {
        ...products.columns,
        total: numeric(12, 2).generatedAs((c) => `${c('price')} * ${c('qty')} * 1.2`),
      },
      { indexes: (t) => [t.using('gin', 'search'), t.using('gin', ['name', 'gin_trgm_ops'])] },
    )
    const changes = await drift([v2])
    expect(changes.map((c) => c.label)).toEqual(['~ column  products.total generated expression'])
    const migration = migrationSql(changes)
    expect(migration).toContain('alter table products alter column total set expression as ("price" * "qty" * 1.2);')
    await apply(migration, 'up')
    expect(await drift([v2])).toEqual([])
    expect(await db.value(sql`select total from products where name = 'Lamp oil'`)).toBe('4.80')
    await apply(migration, 'down')
    expect(await drift([products])).toEqual([])

    const plain = table(
      'products',
      { ...products.columns, total: numeric(12, 2).nullable() },
      {
        indexes: (t) => [t.using('gin', 'search'), t.using('gin', ['name', 'gin_trgm_ops'])],
      },
    )
    const back = await drift([plain])
    expect(back.map((c) => c.label)).toEqual(['~ column  products.total no longer generated'])
    expect(back[0]?.warning).toContain('dropped and added again')
    await apply(migrationSql(back), 'up')
    expect(await drift([plain])).toEqual([])
  })

  test('an index method or operator class change is a changed index', async () => {
    const trigramless = table(
      'products',
      { ...products.columns, total: numeric(12, 2).nullable() },
      {
        indexes: (t) => [t.using('gin', 'search'), t.using('gin', 'search', ['name', 'gin_trgm_ops'])],
      },
    )
    const labels = (await drift([trigramless])).map((c) => c.label)
    expect(labels).toContain('+ index   products_search_name_gin_idx')
    expect(labels).toContain('- index   products_name_gin_idx')
  })
})
