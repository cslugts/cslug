import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, Logger, runInContext } from '@cslug/core'
import { Embedder, FakeEmbedder } from '@cslug/search'
import { testApp } from '@cslug/testing'
import { Ai, AiBudgetError, AiProvider, OpenAiCompatibleEmbedder, VoyageEmbedder } from '../src'

const FIXTURE = join(import.meta.dir, 'fixture')

type Seen = { path: string; headers: Headers; body: Record<string, unknown> }
const seen: Seen[] = []
/** Answers like OpenAI and Voyage: vectors listed out of order (as the APIs allow), with usage. */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { input: string[] }
    seen.push({ path: new URL(req.url).pathname, headers: req.headers, body })
    const data = body.input.map((text, index) => ({ index, embedding: [text.length, index, 1] })).reverse()
    return Response.json(
      new URL(req.url).pathname.startsWith('/voyage')
        ? { data, usage: { total_tokens: 1000 } }
        : { data, usage: { prompt_tokens: 1000, total_tokens: 1000 } },
    )
  },
})
afterAll(() => server.stop(true))
const base = server.url.origin

describe('embedding drivers', () => {
  test('OpenAI-compatible: POST /embeddings { model, input, dimensions }, vectors back in input order', async () => {
    const e = new OpenAiCompatibleEmbedder({
      driver: 'openai-compatible',
      baseUrl: `${base}/v1/`,
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dimensions: 256,
    })
    expect(e.model).toBe('text-embedding-3-small@256') // the dimensions are part of what identifies the vectors
    expect(await e.embed(['a', 'bbb'], 'document')).toEqual([
      [1, 0, 1],
      [3, 1, 1],
    ])
    const req = seen.at(-1) as Seen
    expect(req.path).toBe('/v1/embeddings')
    expect(req.headers.get('authorization')).toBe('Bearer sk-test')
    expect(req.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'bbb'], dimensions: 256 })
    expect(await e.embed([], 'query')).toEqual([])
  })

  test('Voyage: input_type is the purpose, output_dimension; the key from VOYAGE_API_KEY', async () => {
    const e = new VoyageEmbedder({
      driver: 'voyage',
      baseUrl: `${base}/voyage/v1`,
      model: 'voyage-3.5',
      apiKey: 'pa-x',
    })
    await e.embed(['louer une voiture'], 'query')
    expect((seen.at(-1) as Seen).body).toEqual({
      model: 'voyage-3.5',
      input: ['louer une voiture'],
      input_type: 'query',
    })
    expect((seen.at(-1) as Seen).headers.get('authorization')).toBe('Bearer pa-x')
    const sized = new VoyageEmbedder({
      driver: 'voyage',
      baseUrl: `${base}/voyage/v1`,
      model: 'voyage-3.5',
      dimensions: 512,
      apiKey: 'k',
    })
    await sized.embed(['x'], 'document')
    expect((seen.at(-1) as Seen).body).toMatchObject({ input_type: 'document', output_dimension: 512 })
    const saved = process.env.VOYAGE_API_KEY
    delete process.env.VOYAGE_API_KEY
    expect(new VoyageEmbedder({ driver: 'voyage', model: 'voyage-3.5' }).embed(['x'], 'query')).rejects.toThrow(
      'Set VOYAGE_API_KEY',
    )
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved
  })
})

describe('ai.embeddings → @cslug/search', () => {
  const app = () =>
    new Application({
      root: FIXTURE,
      configs: {
        ai: {
          embeddings: { driver: 'voyage', baseUrl: `${base}/voyage/v1`, apiKey: 'k', model: 'voyage-3.5-lite' },
          budget: { perDay: { usd: 0.0001 } },
          prices: { 'voyage-3.5-lite': { input: 0.02, output: 0 } },
        },
      },
    }).useProviders([AiProvider])

  test('AiProvider binds the Embedder; calls are charged to the daily budget and stop when it is spent', async () => {
    const a = app()
    a.singleton(Logger, () => Logger.null())
    await a.start()
    await runInContext({ app: a, scope: a.createScope() }, async () => {
      const embedder = a.resolve(Embedder)
      expect(embedder.model).toBe('voyage-3.5-lite')
      await embedder.embed(['x'], 'document') // 1000 tokens × $0.02 / M = $0.00002
      expect(await a.resolve(Ai).budget?.spent()).toBeCloseTo(0.00002)
      for (let i = 0; i < 4; i++) await embedder.embed(['x'], 'document')
      expect(embedder.embed(['x'], 'document')).rejects.toBeInstanceOf(AiBudgetError)
    })
    await a.shutdown()
  })

  describe('fakes: [ai]', () => {
    const t = testApp({ create: app, fakes: ['ai'] })
    test('the configured Embedder is swapped for a FakeEmbedder: no provider call from a test', async () => {
      const calls = seen.length
      const embedder = t.resolve(Embedder)
      expect(embedder).toBeInstanceOf(FakeEmbedder)
      await embedder.embed(['x'], 'query')
      expect(seen.length).toBe(calls)
    })
  })
})
