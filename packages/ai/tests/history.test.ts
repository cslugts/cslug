import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, inject, Logger, runInContext } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { v } from '@cslug/validation'
import {
  Agent,
  Ai,
  AiProvider,
  type Message,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type StreamEvent,
  Tool,
} from '../src'

const FIXTURE = join(import.meta.dir, 'fixture')

@inject()
class VisaTool extends Tool {
  name = 'visa_rules'
  description = 'Visa rules for a nationality'
  input = v.object({ nationality: v.string() })
  handle({ nationality }: v.infer<this['input']>) {
    return { nationality, visaOnArrival: true }
  }
}

@inject()
class VisaAssistantAgent extends Agent {
  model = 'claude-sonnet-5-5'
  instructions = 'Answer visa questions for Madagascar.'
  tools = [VisaTool]
}

@inject()
class TripAgent extends Agent {
  model = 'claude-haiku-5-5'
  output = v.object({ nights: v.int() })
}

/** Answers from a script; records a copy of each request. */
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
      if (b.type === 'text') for (const word of b.text.split(' ')) yield { type: 'text', text: `${word} ` }
    yield { type: 'done', response }
  }
}
const usage = { inputTokens: 1, outputTokens: 1 }
const said = (text: string): ModelResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage })
const thinking: ModelResponse['content'][number] = {
  type: 'raw',
  value: { type: 'thinking', thinking: '', signature: 's' },
}

async function aiApp() {
  const app = new Application({ root: FIXTURE, configs: { ai: { default: 'script' } } }).useProviders([AiProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  return app
}
const within = <T>(app: Application, fn: () => T) => runInContext({ app, scope: app.createScope() }, fn)

describe('conversations: history in, messages out', () => {
  test('a second turn continues the first, tool rounds and provider blocks included, append-only', async () => {
    const app = await aiApp()
    const script = new Scripted([
      {
        content: [thinking, { type: 'tool_use', id: 't1', name: 'visa_rules', input: { nationality: 'IT' } }],
        stopReason: 'tool_use',
        usage,
      },
      said('Italians get a visa on arrival.'),
      said('Yes, for 30 days.'),
    ])
    app.resolve(Ai).extend('script', script)
    const agent = within(app, () => app.resolve(VisaAssistantAgent))

    const first = await within(app, () => agent.result({ input: 'Do Italians need a visa?' }))
    expect(first.value).toBe('Italians get a visa on arrival.')
    expect(first.messages.map((m) => [m.role, m.content.map((b) => b.type).join(',')])).toEqual([
      ['user', 'text'],
      ['assistant', 'raw,tool_use'],
      ['user', 'tool_result'],
      ['assistant', 'text'],
    ])

    const stored = JSON.parse(JSON.stringify(first.messages)) as Message[] // as an app would store and load it
    const second = await within(app, () => agent.result({ input: 'Can it be extended?', history: stored }))
    expect(second.value).toBe('Yes, for 30 days.')
    const sent = script.requests.at(-1) as ModelRequest
    expect(sent.messages.slice(0, 4)).toEqual(first.messages) // the earlier turns, unchanged
    expect(sent.messages[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Can it be extended?' }] })
    expect(second.messages).toHaveLength(6)
    expect(stored).toHaveLength(4) // the history passed in is not modified
    await app.shutdown()
  })

  test('stream(): the text as it arrives, then .result with the messages; an error rejects both', async () => {
    const app = await aiApp()
    app.resolve(Ai).extend('script', new Scripted([said('Visa on arrival.')]))
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ]
    const stream = within(app, () => app.resolve(VisaAssistantAgent).stream({ input: 'Visa for IT?', history }))
    let text = ''
    for await (const piece of stream) text += piece
    expect(text).toBe('Visa on arrival. ')
    const result = await stream.result
    expect(result.value).toBe('Visa on arrival.')
    expect(result.messages).toHaveLength(4)

    app.resolve(Ai).extend('script', new Scripted([]))
    const failing = within(app, () => app.resolve(VisaAssistantAgent).stream({ input: 'x' }))
    expect(
      (async () => {
        for await (const _ of failing);
      })(),
    ).rejects.toThrow('script exhausted')
    expect(failing.result).rejects.toThrow('script exhausted')
    await app.shutdown()
  })
})

describe('the ai fake with history', () => {
  const t = testApp({ create: () => new Application({ root: FIXTURE }).useProviders([AiProvider]), fakes: ['ai'] })

  test('runs record their history; results and streams continue it', async () => {
    t.ai.respond(TripAgent, (run) => ({ nights: run.history.length + 2 }))
    const first = await t.resolve(TripAgent).result({ input: 'Isalo trip' })
    expect(first.value).toEqual({ nights: 2 })
    expect(first.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Isalo trip' }] },
      { role: 'assistant', content: [{ type: 'text', text: '{"nights":2}' }] },
    ])
    const stream = t.resolve(TripAgent).stream({ input: 'longer?', history: first.messages })
    const pieces: string[] = []
    for await (const piece of stream) pieces.push(piece)
    expect(pieces).toEqual(['{"nights":4}'])
    expect((await stream.result).messages).toHaveLength(4)
    t.ai.assertRan(TripAgent, (run) => run.history.length === 2 && run.input === 'longer?')
    expect(await t.resolve(TripAgent).run({ input: 'plain run' })).toEqual({ nights: 2 })
  })
})
