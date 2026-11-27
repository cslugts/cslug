import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, ConsoleIO, inject, Logger, runInContext } from '@cslug/core'
import {
  Agent,
  Ai,
  AiPromptsCommand,
  AiProvider,
  fillPrompt,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  prompt,
  type StreamEvent,
} from '../src'

describe('fillPrompt', () => {
  test('nested paths, objects and lists as JSON, dates as ISO, bigint as text', () => {
    const text = fillPrompt('{{ trip.circuit.name }} for {{ trip.size }}: {{ stops }} {{ when }} {{ price }}', {
      trip: { circuit: { name: 'Isalo' }, size: 4 },
      stops: ['Ranohira', { name: 'Ilakaka' }],
      when: new Date('2026-12-01T06:00:00Z'),
      price: 210000n,
    })
    expect(text).toBe(
      'Isalo for 4: [\n  "Ranohira",\n  {\n    "name": "Ilakaka"\n  }\n] 2026-12-01T06:00:00.000Z 210000',
    )
    expect(fillPrompt('{{ order }}', { order: { total: 5n } })).toBe('{\n  "total": "5"\n}')
  })

  test('defaults: used when the value is missing or null; empty is allowed; zero and false are values', () => {
    const template = 'Speak {{ language | English }}, tone {{ tone|warm and brief }}, note:{{ note | }}.'
    expect(fillPrompt(template, {})).toBe('Speak English, tone warm and brief, note:.')
    expect(fillPrompt(template, { language: 'Italian', tone: null, note: 'none' })).toBe(
      'Speak Italian, tone warm and brief, note:none.',
    )
    expect(fillPrompt('{{ n | 9 }} {{ ok | yes }}', { n: 0, ok: false })).toBe('0 false')
  })

  test('missing values without a default are one error naming each; a present null without a default is empty', () => {
    expect(() => fillPrompt('{{ a }} {{ b.c }} {{ a }}', { b: {} }, 'offers/extract')).toThrow(
      'Prompt offers/extract needs a, b.c in context',
    )
    expect(() => fillPrompt('{{ trip.name }}', { trip: 'Isalo' })).toThrow('needs trip.name') // not an object
    expect(fillPrompt('[{{ x }}]', { x: null })).toBe('[]')
  })
})

/** Records each request. */
class Recording implements Provider {
  requests: ModelRequest[] = []
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request)
    return {
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  }
  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.complete(request) }
  }
}

describe('instructions', () => {
  const root = mkdtempSync(join(tmpdir(), 'cslug-prompts-'))
  mkdirSync(join(root, 'resources/prompts/trips'), { recursive: true })
  writeFileSync(
    join(root, 'resources/prompts/trips/brief.md'),
    'Brief {{ traveller.name }} on {{ circuit }} in {{ language | English }}.\n',
  )

  const run = async (agent: Agent, context: Record<string, unknown>) => {
    const app = new Application({ root, configs: { ai: { default: 'rec' } } }).useProviders([AiProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
    const provider = new Recording()
    app.resolve(Ai).extend('rec', provider)
    await runInContext({ app, scope: app.createScope() }, () => app.resolve(Ai).run(agent, { input: 'x', context }))
    await app.shutdown()
    return provider.requests[0]?.system
  }

  @inject()
  class FileAgent extends Agent {
    model = 'claude-haiku-5-5'
    instructions = prompt('trips/brief')
  }

  @inject()
  class CodeAgent extends Agent {
    model = 'claude-haiku-5-5'
    instructions = async (context: Record<string, unknown>) =>
      context.vip ? prompt('trips/brief') : `Answer about ${String(context.circuit)} in one line.`
  }

  test('a prompt file, filled from the context (nested values, defaults)', async () => {
    expect(await run(new FileAgent(), { traveller: { name: 'Giulia' }, circuit: 'Isalo' })).toBe(
      'Brief Giulia on Isalo in English.\n',
    )
  })

  test('a function of the context: a string, or a prompt filled from the same context', async () => {
    expect(await run(new CodeAgent(), { circuit: 'Tsingy' })).toBe('Answer about Tsingy in one line.')
    expect(
      await run(new CodeAgent(), { vip: true, traveller: { name: 'Ada' }, circuit: 'Tsingy', language: 'Italian' }),
    ).toBe('Brief Ada on Tsingy in Italian.\n')
  })

  test('cslug ai:prompts lists the variables; those with a default end with ?', async () => {
    const app = new Application({ root }).useProviders([AiProvider])
    let out = ''
    app.instance(
      ConsoleIO,
      new (class extends ConsoleIO {
        override write(text: string) {
          out += text
        }
      })(),
    )
    await runInContext({ app, scope: app.createScope() }, () => new AiPromptsCommand().handle({ json: true }))
    expect(JSON.parse(out)).toEqual([{ prompt: 'trips/brief', variables: 'traveller.name, circuit, language?' }])
    rmSync(root, { recursive: true, force: true })
  })
})
