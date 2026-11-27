import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, Clock, type Command, ConsoleIO, FakeClock, inject, Logger, runInContext } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { v } from '@cslug/validation'
import {
  Agent,
  Ai,
  AiBudgetAlert,
  AiBudgetError,
  AiEvalCommand,
  type AiFixture,
  AiProvider,
  AiRecordCommand,
  costOf,
  jsonDiff,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type StreamEvent,
} from '../src'

const FIXTURE = join(import.meta.dir, 'fixture')

@inject()
class PriceAgent extends Agent {
  model = 'claude-haiku-5-5'
  instructions = 'Read the price.'
  output = v.object({ price: v.int().min(1) })
}

/** Answers every call with `text`, charging `usage`. */
class Fixed implements Provider {
  requests: ModelRequest[] = []
  constructor(
    private readonly texts: string[],
    private readonly usage = { inputTokens: 10, outputTokens: 10 },
  ) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const text = this.texts.length > 1 ? (this.texts.shift() as string) : (this.texts[0] as string)
    return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: this.usage }
  }
  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.complete(request) }
  }
}

class Captured extends ConsoleIO {
  out = ''
  override write(text: string) {
    this.out += text
  }
  override error(text: string) {
    this.out += text
  }
}

async function command(app: Application, cmd: new () => Command, args: Record<string, unknown>) {
  const io = new Captured()
  app.swap(ConsoleIO, io)
  const code = await runInContext({ app, scope: app.createScope() }, () =>
    (new cmd() as unknown as { handle(a: unknown): unknown }).handle(args),
  )
  app.restoreSwaps()
  return { code, out: io.out }
}

async function aiApp(ai: Record<string, unknown>) {
  const app = new Application({ root: FIXTURE, configs: { ai: { default: 'fixed', ...ai } } }).useProviders([
    AiProvider,
  ])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  return app
}
const within = <T>(app: Application, fn: () => T) => runInContext({ app, scope: app.createScope() }, fn)

describe('cost', () => {
  test('price per million tokens; cache reads 0.1×, cache writes 1.25× the input price', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(costOf('claude-opus-5-5', usage)).toBe(24)
    expect(
      costOf('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }),
    ).toBeCloseTo(0.4 + 5)
    expect(costOf('llama3', usage)).toBeUndefined()
    expect(costOf('llama3', usage, { llama3: { input: 0, output: 1 } })).toBe(1)
  })

  test('jsonDiff: the paths that changed', () => {
    expect(jsonDiff({ a: 1, b: [1, 2], c: { d: 'x' } }, { a: 1, b: [1, 3], c: { e: 'x' } })).toEqual([
      'b[1]: 2 → 3',
      'c.d: "x" → (none)',
      'c.e: (none) → "x"',
    ])
    expect(jsonDiff('same', 'same')).toEqual([])
    expect(jsonDiff('a', 'b')).toEqual(['(answer): "a" → "b"'])
  })
})

describe('daily budget', () => {
  test('charged per call, AiBudgetAlert once at alertAt, AiBudgetError once spent, reset the next day', async () => {
    // claude-opus-5-5, 10k in + 10k out = $0.24 a call; limit $0.50, alert at 80% ($0.40)
    const app = await aiApp({ budget: { perDay: { usd: 0.5 }, alertAt: 0.8 } })
    const clock = new FakeClock('UTC', '2026-11-27T10:00:00Z')
    app.swap(Clock, clock)
    const provider = new Fixed(['{"price": 1}'], { inputTokens: 10_000, outputTokens: 10_000 })
    const ai = app.resolve(Ai).extend('fixed', provider)
    const alerts: unknown[] = []
    within(app, () => AiBudgetAlert.on((payload) => void alerts.push(payload)))
    class OpusAgent extends PriceAgent {
      override model = 'claude-opus-5-5'
    }
    const agent = new OpusAgent()

    const first = await within(app, () => ai.result(agent, { input: 'x' }))
    expect(first.costUsd).toBeCloseTo(0.24)
    expect(alerts).toEqual([])
    await within(app, () => ai.run(agent, { input: 'x' }))
    expect(await ai.budget?.spent()).toBeCloseTo(0.48)
    expect(alerts).toEqual([{ day: '2026-11-27', spentUsd: 0.48, limitUsd: 0.5 }])
    await within(app, () => ai.run(agent, { input: 'x' })) // under the limit before the call: it runs
    const error = await within(app, () => ai.run(agent, { input: 'x' })).catch((e) => e)
    expect(error).toBeInstanceOf(AiBudgetError)
    expect((error as AiBudgetError).message).toContain('$0.72 of $0.5')
    expect(provider.requests).toHaveLength(3)
    expect(alerts).toHaveLength(1)

    clock.advance('1d')
    await within(app, () => ai.run(agent, { input: 'x' }))
    expect(provider.requests).toHaveLength(4)
    await app.shutdown()
  })

  test('no budget configured: nothing is tracked', async () => {
    const app = await aiApp({})
    const ai = app.resolve(Ai).extend('fixed', new Fixed(['{"price": 1}']))
    expect(ai.budget).toBeUndefined()
    const result = await within(app, () => ai.result(new PriceAgent(), { input: 'x' }))
    expect(result).toMatchObject({ value: { price: 1 }, raw: { price: 1 }, model: 'claude-haiku-5-5', steps: 1 })
    await app.shutdown()
  })
})

describe('fixtures: t.ai.fixture() and recording (cslug ai:record)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cslug-ai-fixtures-'))
  // the "real" provider while recording: an OpenAI-compatible endpoint
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      calls++
      return Response.json({
        choices: [{ message: { content: `{"price": ${2000 + calls}}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      })
    },
  })
  const t = testApp({
    create: () =>
      new Application({
        root,
        configs: {
          ai: { default: 'local', providers: { local: { driver: 'openai-compatible', baseUrl: server.url.href } } },
        },
      }).useProviders([AiProvider]),
    fakes: ['ai'],
  })
  afterEach(() => {
    delete process.env.CSLUG_AI_RECORD
  })
  afterAll(() => {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  })
  const path = join(root, 'tests/fixtures/ai/prices/isalo.json')

  test('a missing fixture says how to record it', async () => {
    t.ai.fixture(PriceAgent, 'prices/isalo')
    expect(t.resolve(PriceAgent).run({ input: 'Isalo' })).rejects.toThrow(
      'No AI fixture tests/fixtures/ai/prices/isalo.json: record it with `cslug ai:record',
    )
  })

  test('recording calls the real provider once and writes the fixture; replays read it', async () => {
    process.env.CSLUG_AI_RECORD = 'missing'
    t.ai.fixture(PriceAgent, 'prices/isalo')
    expect(await t.resolve(PriceAgent).run({ input: 'Isalo, 2001 EUR', context: { lang: 'fr' } })).toEqual({
      price: 2001,
    })
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as AiFixture
    expect(fixture).toMatchObject({
      agent: 'PriceAgent',
      input: 'Isalo, 2001 EUR',
      context: { lang: 'fr' },
      output: { price: 2001 },
      model: 'claude-haiku-5-5',
    })
    // missing only: an existing fixture is replayed, not re-recorded
    expect(await t.resolve(PriceAgent).run({ input: 'again' })).toEqual({ price: 2001 })
    expect(calls).toBe(1)

    process.env.CSLUG_AI_RECORD = 'all'
    expect(await t.resolve(PriceAgent).run({ input: 'again' })).toEqual({ price: 2002 })
    expect(calls).toBe(2)

    delete process.env.CSLUG_AI_RECORD
    expect(await t.resolve(PriceAgent).run({ input: 'replayed' })).toEqual({ price: 2002 })
    expect(calls).toBe(2)
    t.ai.assertRan(PriceAgent, (run) => run.input === 'replayed')
    expect(existsSync(path)).toBe(true)
  })
})

describe('cslug ai:eval', () => {
  test('fixtures through the real model: same, diff, schema failure (exit 1); --strict fails on diffs', async () => {
    const app = await aiApp({})
    const answers = () => [
      '{"price": 2300, "currency": "EUR"}', // diff.json
      '{"price": 2100, "currency": "EUR"}', // same.json
      '{"price": 0, "currency": "EUR"}', // schema.json: below the minimum
    ]
    const provider = new Fixed(answers())
    app.resolve(Ai).extend('fixed', provider)
    const { code, out } = await command(app, AiEvalCommand, { folder: 'offers', strict: false, json: true })
    expect(code).toBe(1)
    const rows = JSON.parse(out) as { fixture: string; result: string; details: string }[]
    expect(rows.map((r) => [r.fixture, r.result])).toEqual([
      ['offers/diff', 'diff'],
      ['offers/same', 'same'],
      ['offers/schema', 'schema'],
    ])
    expect(rows[0]?.details).toBe('price: 2100 → 2300')
    expect(provider.requests[0]?.messages[0]?.content).toEqual([{ type: 'text', text: 'Prix: 2100 EUR (diff)' }])

    app.resolve(Ai).extend('fixed', new Fixed(answers().slice(0, 2)))
    const lenient = await command(app, AiEvalCommand, { folder: 'offers', strict: false, json: false })
    expect(lenient.out).toContain('2 same, 1 diff, 0 schema failures, 0 errors')
    expect(lenient.code).toBe(0)
    app.resolve(Ai).extend('fixed', new Fixed(answers().slice(0, 2)))
    expect((await command(app, AiEvalCommand, { folder: 'offers', strict: true, json: false })).code).toBe(1)

    const none = await command(app, AiEvalCommand, { folder: 'nothing', strict: false, json: false })
    expect(none.code).toBe(1)
    expect(none.out).toContain('No fixtures in tests/fixtures/ai/nothing')
    await app.shutdown()
  })
})

describe('cslug ai:record', () => {
  test('runs bun test (optionally one path) with CSLUG_AI_RECORD = missing, or all with --all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cslug-ai-record-'))
    writeFileSync(
      join(root, 'mode.test.ts'),
      `import { test } from 'bun:test'\nimport { appendFileSync } from 'node:fs'\ntest('mode', () => appendFileSync(${JSON.stringify(join(root, 'modes'))}, process.env.CSLUG_AI_RECORD + '\\n'))\n`,
    )
    const app = new Application({ root })
    expect((await command(app, AiRecordCommand, { path: 'mode.test.ts', all: false })).code).toBe(0)
    const all = await command(app, AiRecordCommand, { all: true })
    expect(all.code).toBe(0)
    expect(all.out).toContain('the real provider is called')
    expect(readFileSync(join(root, 'modes'), 'utf8')).toBe('missing\nall\n')
    rmSync(root, { recursive: true, force: true })
  })
})
