import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Application, Logger, runInContext } from '@cslug/core'
import { Database, sql } from '@cslug/database'
import { SQL } from 'bun'
import { Embedder, FakeEmbedder, SEARCH_MIGRATIONS, searchIndex, VECTOR_MIGRATIONS } from '../src'

const DATABASE_URL = process.env.DATABASE_URL
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] as number), 0)

test('FakeEmbedder: shared words (accents and plurals folded) or shared concepts are close', async () => {
  const e = new FakeEmbedder({ concepts: { car: 'vehicle', '4x4': 'vehicle', truck: 'vehicle' } })
  const [a, b, c, d] = await e.embed(['éléphants', 'elephant', '4x4 rental', 'car rentals'], 'document')
  expect(cosine(a as number[], b as number[])).toBeCloseTo(1)
  expect(cosine(c as number[], d as number[])).toBeCloseTo(1) // 4x4 ≈ car, rental ≈ rentals
  expect(cosine(a as number[], c as number[])).toBeLessThan(0.5)
  expect(e.model).toBe('fake-64')
  expect(e.calls).toEqual([{ texts: ['éléphants', 'elephant', '4x4 rental', 'car rentals'], purpose: 'document' }])
})

test('semantic modes need a semantic index and a bound Embedder', async () => {
  const app = new Application()
  const plain = searchIndex('plain-index')
  const meaning = searchIndex('meaning-index', { semantic: true })
  await runInContext({ app, scope: app.createScope() }, async () => {
    expect(plain.search('x', { mode: 'semantic' })).rejects.toThrow('Index plain-index is not semantic')
    expect(meaning.search('x')).rejects.toThrow('no Embedder is bound: configure ai.embeddings')
  })
})

/** pgvector on this server (CI's pgvector/pgvector image has it; a plain local PostgreSQL may not). */
async function hasPgvector() {
  if (!DATABASE_URL) return false
  const conn = new SQL(DATABASE_URL, { max: 1 })
  const [row] = await conn`select count(*)::int as n from pg_available_extensions where name = 'vector'`
  await conn.close()
  return row.n > 0
}
const PGVECTOR = await hasPgvector()

describe.skipIf(!PGVECTOR)('semantic and hybrid search (pgvector)', () => {
  const name = `cslug_semantic_${process.pid}`
  const admin = new SQL(Object.assign(new URL(DATABASE_URL as string), { pathname: '/postgres' }).toString(), {
    max: 1,
  })
  let db: Database
  let app: Application
  const embedder = new FakeEmbedder({
    concepts: { car: 'vehicle', '4x4': 'vehicle', vehicle: 'vehicle', truck: 'vehicle' },
  })
  const inApp = <T>(fn: () => Promise<T>) => runInContext({ app, scope: app.createScope() }, fn)
  const migrate = async (dir: string, file: string) =>
    db.pool.unsafe(readFileSync(join(dir, file), 'utf8').split('-- down')[0] as string)
  const guide = searchIndex<{ kind: string }>('guide', { languages: ['english'], semantic: true })
  const keys = (page: { data: { key: string }[] }) => page.data.map((h) => h.key)

  beforeAll(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.unsafe(`create database "${name}"`)
    const url = Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString()
    db = new Database({ url, slowQueryMs: 10_000 }, Logger.null())
    await migrate(SEARCH_MIGRATIONS, '00000000_000600_cslug_search.sql')
    await migrate(SEARCH_MIGRATIONS, '00000000_000610_cslug_search_documents.sql')
    app = new Application().instance(Database, db).instance(Embedder, embedder)
  })
  afterAll(async () => {
    await db?.close()
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.close()
  })

  test('without the embeddings migration: a clear error', async () => {
    expect(inApp(() => guide.upsert({ key: 'x', title: 'x' }))).rejects.toThrow(
      'set `vectors: true` in config/search.ts',
    )
    await migrate(VECTOR_MIGRATIONS, '00000000_000620_cslug_search_embeddings.sql')
    await db.exec(sql`delete from cslug_search_documents`)
  })

  test('upsert embeds title and body; unchanged documents are not embedded again; a change is', async () => {
    embedder.calls.length = 0
    await inApp(() =>
      guide.upsertMany([
        { key: 'rental', title: 'Renting a 4x4', body: 'Drivers and fuel included', metadata: { kind: 'transport' } },
        { key: 'lemurs', title: 'Lemurs', body: 'Ring-tailed lemurs in Isalo', metadata: { kind: 'wildlife' } },
        {
          key: 'roads',
          title: 'Roads',
          body: 'The RN7 is paved; a car is fine in the dry season',
          metadata: { kind: 'transport' },
        },
      ]),
    )
    expect(embedder.calls).toEqual([
      {
        texts: [
          'Renting a 4x4\n\nDrivers and fuel included',
          'Lemurs\n\nRing-tailed lemurs in Isalo',
          'Roads\n\nThe RN7 is paved; a car is fine in the dry season',
        ],
        purpose: 'document',
      },
    ])
    await inApp(() =>
      guide.upsert({
        key: 'lemurs',
        title: 'Lemurs',
        body: 'Ring-tailed lemurs in Isalo',
        metadata: { kind: 'wildlife' },
      }),
    )
    expect(embedder.calls).toHaveLength(1) // same text: no call
    await inApp(() =>
      guide.upsert({
        key: 'lemurs',
        title: 'Lemurs',
        body: 'Sifakas and ring-tailed lemurs',
        metadata: { kind: 'wildlife' },
      }),
    )
    expect(embedder.calls).toHaveLength(2)
    expect(embedder.calls[1]?.texts).toEqual(['Lemurs\n\nSifakas and ring-tailed lemurs'])
  })

  test('semantic: by meaning, where full text finds nothing; rank is the cosine similarity', async () => {
    expect(keys(await inApp(() => guide.search('vehicle hire', { mode: 'text' })))).toEqual([])
    const found = await inApp(() => guide.search('vehicle hire', { mode: 'semantic', minSimilarity: 0.2 }))
    expect(keys(found).slice(0, 2).sort()).toEqual(['rental', 'roads'])
    expect(found.data.every((h) => h.rank > 0.2 && h.rank <= 1)).toBe(true)
    expect(embedder.calls.at(-1)).toEqual({ texts: ['vehicle hire'], purpose: 'query' })
    expect(
      keys(
        await inApp(() =>
          guide.search('vehicle', { mode: 'semantic', filter: { kind: 'wildlife' }, minSimilarity: 0.2 }),
        ),
      ),
    ).toEqual([])
  })

  test('hybrid (the default for a semantic index): words and meaning fused; a match by both comes first', async () => {
    // words: only "roads" has both "paved" and "car"; meaning: car ≈ 4x4 brings "rental" too
    expect(keys(await inApp(() => guide.search('paved car', { mode: 'text' })))).toEqual(['roads'])
    const page = await inApp(() => guide.search('paved car', { highlight: true, minSimilarity: 0.1 }))
    expect(page.data[0]?.key).toBe('roads')
    expect(keys(page)).toContain('rental')
    expect(page.meta.total).toBe(page.data.length)
    expect(page.data[0]?.highlight?.body).toContain('<mark>paved</mark>')
    expect((page.data[0]?.rank ?? 0) > (page.data.at(-1)?.rank ?? 0)).toBe(true)
  })

  test('another model: its vectors are separate and documents are embedded again; remove drops embeddings', async () => {
    const other = new FakeEmbedder({ dimensions: 32 })
    app.instance(Embedder, other)
    await inApp(() =>
      guide.upsert({
        key: 'roads',
        title: 'Roads',
        body: 'The RN7 is paved; a car is fine in the dry season',
        metadata: { kind: 'transport' },
      }),
    )
    expect(other.calls).toHaveLength(1)
    expect(keys(await inApp(() => guide.search('paved roads', { mode: 'semantic' })))).toEqual(['roads']) // only fake-32 vectors
    app.instance(Embedder, embedder)
    await inApp(() => guide.remove('rental'))
    expect(await db.value(sql`select count(*)::int from cslug_search_embeddings where key = 'rental'`)).toBe(0)
  })
})
