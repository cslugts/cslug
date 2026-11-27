import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, inject, Logger, runInContext } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { v } from '@cslug/validation'
import {
  Agent,
  Ai,
  AiOutputError,
  AiProvider,
  AiRefusalError,
  AnthropicProvider,
  type ModelRequest,
  type ModelResponse,
  modelSchema,
  OpenAiCompatibleProvider,
  type Provider,
  prompt,
  type StreamEvent,
  sse,
  Tool,
} from '../src'

const FIXTURE = join(import.meta.dir, 'fixture')

// ── an app, agents and tools like guide 18's ─────────────────────────────────────────────────────────
const OfferSchema = v.object({
  price: v.int().min(1),
  inclusions: v.array(v.enum(['guide', 'meals', 'fuel'])),
  nightDriving: v.boolean().describe('True if any leg is after dark'),
})

@inject()
class OfferExtractorAgent extends Agent {
  model = 'fast'
  instructions = prompt('offers/extract')
  output = OfferSchema
}

const seen: unknown[] = []
@inject()
class FindOperatorsTool extends Tool {
  name = 'find_operators'
  description = 'Operators for a circuit'
  input = v.object({ circuit: v.string(), groupSize: v.int().min(1) })
  async handle(input: v.infer<this['input']>) {
    seen.push(input)
    if (input.circuit === 'boom') throw new Error('database down')
    return [{ name: 'Ravinala', seats: 7 }]
  }
}

@inject()
class TriageAgent extends Agent {
  model = 'claude-opus-5-5'
  instructions = 'Find operators.'
  tools = [FindOperatorsTool]
  maxSteps = 3
}

/** A provider that answers from a script and records each request. */
class Scripted implements Provider {
  readonly requests: ModelRequest[] = []
  constructor(private readonly answers: ModelResponse[]) {}
  async complete(request: ModelRequest) {
    this.requests.push(structuredClone(request))
    const next = this.answers.shift()
    if (!next) throw new Error('script exhausted')
    return next
  }
  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.complete(request)
    for (const b of response.content)
      if (b.type === 'text') for (const word of b.text.split(' ')) yield { type: 'text', text: word }
    yield { type: 'done', response }
  }
}
const said = (text: string): ModelResponse => ({
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
})
const calls = (...uses: [string, string, unknown][]): ModelResponse => ({
  content: uses.map(([id, name, input]) => ({ type: 'tool_use' as const, id, name, input })),
  stopReason: 'tool_use',
  usage: { inputTokens: 1, outputTokens: 1 },
})

async function aiApp() {
  const app = new Application({
    root: FIXTURE,
    configs: { ai: { default: 'script', models: { fast: 'claude-haiku-5-5' } } },
  }).useProviders([AiProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  return app
}
const within = <T>(app: Application, fn: () => T) => runInContext({ app, scope: app.createScope() }, fn)

test('modelSchema: constraints the API rejects are removed (v still checks them); field names are kept', () => {
  const schema = v.object({ pattern: v.string().max(3), n: v.int().min(1), tags: v.array(v.string()).max(2) })
  expect(modelSchema(schema.toJSONSchema())).toEqual({
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      n: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['pattern', 'n', 'tags'],
    additionalProperties: false,
  })
})

describe('agents (guide 18)', () => {
  test('structured output: role → model, prompt with context, parsed and validated', async () => {
    const app = await aiApp()
    const script = new Scripted([said('{"price": 2100, "inclusions": ["guide"], "nightDriving": false}')])
    app.resolve(Ai).extend('script', script)
    const offer = await within(app, () =>
      app.resolve(OfferExtractorAgent).run({ input: 'Prix 2100, guide inclus', context: { currency: 'EUR' } }),
    )
    expect(offer).toEqual({ price: 2100, inclusions: ['guide'], nightDriving: false })
    const [request] = script.requests
    expect(request?.model).toBe('claude-haiku-5-5')
    expect(request?.system).toBe('You turn operator replies into offers. Prices are in EUR.\n')
    expect(request?.output).toMatchObject({ type: 'object', additionalProperties: false })
    expect(JSON.stringify(request?.output)).not.toContain('minimum')
  })

  test('an answer that breaks the schema (here: below the minimum the API was not told about) is AiOutputError', async () => {
    const app = await aiApp()
    app.resolve(Ai).extend('script', new Scripted([said('{"price": 0, "inclusions": [], "nightDriving": true}')]))
    const error = await within(app, () =>
      app.resolve(OfferExtractorAgent).run({ input: 'x', context: { currency: 'EUR' } }),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(AiOutputError)
    app.resolve(Ai).extend('script', new Scripted([said('Sorry, no JSON')]))
    expect(
      within(app, () => app.resolve(OfferExtractorAgent).run({ input: 'x', context: { currency: 'EUR' } })),
    ).rejects.toBeInstanceOf(AiOutputError)
    expect(within(app, () => app.resolve(OfferExtractorAgent).run({ input: 'x' }))).rejects.toThrow(
      'needs currency in context',
    )
  })

  test('tools: inputs validated, results and errors returned in one message, then the answer', async () => {
    const app = await aiApp()
    const script = new Scripted([
      calls(
        ['t1', 'find_operators', { circuit: 'isalo', groupSize: 4 }],
        ['t2', 'find_operators', { circuit: 'isalo', groupSize: 0 }],
        ['t3', 'find_operators', { circuit: 'boom', groupSize: 2 }],
      ),
      said('Ravinala has 7 seats.'),
    ])
    app.resolve(Ai).extend('script', script)
    const answer = await within(app, () => app.resolve(TriageAgent).run({ input: 'Isalo for 4?' }))
    expect(answer).toBe('Ravinala has 7 seats.')
    expect(seen).toContainEqual({ circuit: 'isalo', groupSize: 4 })
    const results = script.requests[1]?.messages.at(-1)
    expect(results?.role).toBe('user')
    expect(results?.content).toEqual([
      { type: 'tool_result', toolUseId: 't1', content: '[{"name":"Ravinala","seats":7}]', isError: false },
      { type: 'tool_result', toolUseId: 't2', content: expect.stringContaining('Invalid input'), isError: true },
      { type: 'tool_result', toolUseId: 't3', content: 'database down', isError: true },
    ])
    expect(script.requests[0]?.tools[0]).toMatchObject({ name: 'find_operators', inputSchema: { type: 'object' } })
  })

  test('maxSteps ends a run that keeps calling tools', async () => {
    const app = await aiApp()
    const loop = () => calls(['t', 'find_operators', { circuit: 'a', groupSize: 1 }])
    app.resolve(Ai).extend('script', new Scripted([loop(), loop(), loop(), loop()]))
    expect(within(app, () => app.resolve(TriageAgent).run({ input: 'go' }))).rejects.toThrow(
      'did not finish in 3 steps',
    )
  })

  test('stream: text as it arrives; sse() turns it into server-sent events', async () => {
    const app = await aiApp()
    app.resolve(Ai).extend('script', new Scripted([said('Hello there friend')]))
    const res = await within(app, () => sse(app.resolve(TriageAgent).stream({ input: 'hi' })).toResponse())
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: "Hello"\n\ndata: "there"\n\ndata: "friend"\n\nevent: done\ndata: {}\n\n')
  })
})

// ── the providers, against local servers speaking their HTTP APIs ───────────────────────────────────
type Seen = { headers: Headers; body: Record<string, unknown> }
const requests: Seen[] = []
let reply: (body: Record<string, unknown>) => Response = () => new Response('{}')
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>
      requests.push({ headers: req.headers, body })
      return reply(body)
    },
  })
})
afterAll(() => server.stop(true))
const json = (value: unknown) => Response.json(value)
const events = (...frames: [string, unknown][]) =>
  new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
const base: ModelRequest = {
  model: 'claude-opus-5-5',
  system: 'Be brief.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
}

describe('AnthropicProvider (Messages API over fetch)', () => {
  const claude = () => new AnthropicProvider({ driver: 'anthropic', apiKey: 'sk-test', baseUrl: server.url.origin })

  test('the request: headers, cached system prompt, tools, structured output, fallbacks; thinking blocks kept', async () => {
    reply = () =>
      json({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '{"ok":true}' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 400, cache_creation_input_tokens: 50 },
      })
    const out = await claude().complete({
      ...base,
      tools: [{ name: 'find', description: 'Find', inputSchema: { type: 'object' } }],
      output: { type: 'object' },
      effort: 'low',
    })
    const { headers, body } = requests.at(-1) as Seen
    expect([headers.get('x-api-key'), headers.get('anthropic-version'), headers.get('anthropic-beta')]).toEqual([
      'sk-test',
      '2026-10-21',
      'server-side-fallback-2026-07-01',
    ])
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'find', description: 'Find', input_schema: { type: 'object' } }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'low' },
      fallbacks: 'default',
    })
    expect(out).toEqual({
      content: [
        { type: 'raw', value: { type: 'thinking', thinking: '', signature: 'sig' } },
        { type: 'text', text: '{"ok":true}' },
      ],
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 400, cacheWriteTokens: 50 },
    })
  })

  test('tool results and raw blocks go back in the wire shape; no fallbacks on a model without them', async () => {
    reply = () => json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} })
    await claude().complete({
      ...base,
      model: 'claude-haiku-5-5',
      messages: [
        ...base.messages,
        {
          role: 'assistant',
          content: [
            { type: 'raw', value: { type: 'thinking', thinking: '', signature: 's' } },
            { type: 'tool_use', id: 'tu1', name: 'find', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'none', isError: true }] },
      ],
    })
    const { headers, body } = requests.at(-1) as Seen
    expect(headers.get('anthropic-beta')).toBeNull()
    expect(body.fallbacks).toBeUndefined()
    expect((body.messages as unknown[]).slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'tool_use', id: 'tu1', name: 'find', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'none', is_error: true }] },
    ])
  })

  test('a refusal is AiRefusalError with its category; an HTTP error names the status', async () => {
    reply = () =>
      json({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage: {} })
    const refused = await claude()
      .complete(base)
      .catch((e) => e)
    expect([refused instanceof AiRefusalError, refused.category]).toEqual([true, 'cyber'])
    reply = () => new Response('{"error":{"message":"bad"}}', { status: 400 })
    expect(claude().complete(base)).rejects.toThrow('answered 400')
  })

  test('streaming: text deltas, tool input from partial_json, thinking rebuilt from its deltas', async () => {
    reply = () =>
      events(
        ['message_start', { type: 'message_start', message: { id: 'm', usage: { input_tokens: 9 } } }],
        [
          'content_block_start',
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me ' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'look.' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        [
          'content_block_start',
          {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: 'tu', name: 'find', input: {} },
          },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"circuit":' } },
        ],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"isalo"}' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 2 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }],
        ['message_stop', { type: 'message_stop' }],
      )
    const out: StreamEvent[] = []
    for await (const e of claude().stream(base)) out.push(e)
    expect((requests.at(-1) as Seen).body).toMatchObject({ stream: true, max_tokens: 64000 })
    expect(out.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : ''))).toEqual([
      'Let me ',
      'look.',
    ])
    expect(out.at(-1)).toEqual({
      type: 'done',
      response: {
        content: [
          { type: 'raw', value: { type: 'thinking', thinking: '', signature: 'abc' } },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'tu', name: 'find', input: { circuit: 'isalo' } },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 9, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    })
  })
})

describe('OpenAiCompatibleProvider (chat completions)', () => {
  const local = () => new OpenAiCompatibleProvider({ driver: 'openai-compatible', baseUrl: `${server.url.origin}/v1/` })

  test('messages, tools and response_format; tool calls come back as tool_use', async () => {
    reply = () =>
      json({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'find', arguments: '{"circuit":"isalo"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      })
    const out = await local().complete({
      ...base,
      tools: [{ name: 'find', description: 'Find', inputSchema: { type: 'object' } }],
      output: { type: 'object' },
    })
    expect((requests.at(-1) as Seen).body).toEqual({
      model: 'claude-opus-5-5',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'find', description: 'Find', parameters: { type: 'object' } } }],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'output', schema: { type: 'object' }, strict: true },
      },
    })
    expect(out).toEqual({
      content: [{ type: 'tool_use', id: 'c1', name: 'find', input: { circuit: 'isalo' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 5, outputTokens: 2 },
    })
  })

  test('streaming text deltas until [DONE]', async () => {
    reply = () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Bon' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'jour' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
    const out: StreamEvent[] = []
    for await (const e of local().stream(base)) out.push(e)
    expect(out.map((e) => (e.type === 'text' ? e.text : e.response.content))).toEqual([
      'Bon',
      'jour',
      [{ type: 'text', text: 'Bonjour' }],
    ])
  })
})

describe('the ai fake (guide 18 testing)', () => {
  const t = testApp({
    create: () => new Application({ root: FIXTURE }).useProviders([AiProvider]),
    fakes: ['ai'],
  })

  test('respond / assertRan; answers are checked against the output schema', async () => {
    t.ai.respond(OfferExtractorAgent, { price: 2100, inclusions: ['guide'], nightDriving: false })
    const offer = await t.resolve(OfferExtractorAgent).run({ input: 'Isalo, 2100' })
    expect(offer.price).toBe(2100)
    t.ai.assertRan(OfferExtractorAgent, (run) => run.input.includes('Isalo'))
    t.ai.assertNotRan(TriageAgent)
    expect(t.resolve(TriageAgent).run({ input: 'x' })).rejects.toThrow('No fake answer for TriageAgent')
    t.ai.respond(OfferExtractorAgent, { price: -1 })
    expect(t.resolve(OfferExtractorAgent).run({ input: 'x' })).rejects.toBeInstanceOf(AiOutputError)
  })
})
