import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, inject, Logger, runInContext } from '@cslug/core'
import { Database, DatabaseProvider, sql } from '@cslug/database'
import { SearchProvider } from '@cslug/search'
import { testApp } from '@cslug/testing'
import { SQL } from 'bun'
import {
  Agent,
  Ai,
  AiProvider,
  Conversations,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  recallTool,
  type SearchableIndex,
  type StreamEvent,
  searchTool,
} from '../src'

const FIXTURE = join(import.meta.dir, 'fixture')
const usage = { inputTokens: 1, outputTokens: 1 }

/** Calls a tool once (when `call` is set), then answers with the text it was given. */
class Scripted implements Provider {
  requests: ModelRequest[] = []
  call: { name: string; input: unknown } | undefined
  answer = 'ok'
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request))
    const last = request.messages.at(-1)
    if (this.call && !last?.content.some((b) => b.type === 'tool_result'))
      return {
        content: [{ type: 'tool_use', id: 't1', name: this.call.name, input: this.call.input }],
        stopReason: 'tool_use',
        usage,
      }
    return { content: [{ type: 'text', text: this.answer }], stopReason: 'end_turn', usage }
  }
  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.complete(request) }
  }
}
const toolResult = (request: ModelRequest | undefined) =>
  JSON.parse(
    (request?.messages.at(-1)?.content.find((b) => b.type === 'tool_result') as { content: string } | undefined)
      ?.content ?? 'null',
  )

describe('searchTool', () => {
  const searches: unknown[] = []
  const index: SearchableIndex = {
    name: 'help-center',
    async search(term, options) {
      searches.push({ term, options })
      return {
        data: [
          {
            key: 'visa',
            title: 'Visa',
            metadata: { url: '/visa' },
            rank: 0.5,
            highlight: { body: 'The <mark>visa</mark> costs 35 € &amp; is paid on arrival' },
          },
        ],
        meta: { page: 1, total: 1, lastPage: 1 },
      }
    },
    upsertMany: async () => {},
    removeWhere: async () => 0,
  }

  @inject()
  class HelpAgent extends Agent {
    model = 'claude-haiku-5-5'
    tools = [searchTool(index, { description: 'The help center for travellers', filter: { published: true } })]
  }

  test('a tool object in an agent: its schema is sent; the model gets plain-text snippets', async () => {
    const app = new Application({ root: FIXTURE, configs: { ai: { default: 'script' } } }).useProviders([AiProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
    const script = new Scripted()
    script.call = { name: 'search_help_center', input: { query: 'visa price' } }
    app.resolve(Ai).extend('script', script)
    await runInContext({ app, scope: app.createScope() }, () =>
      app.resolve(HelpAgent).run({ input: 'How much is the visa?' }),
    )
    const [first, second] = script.requests
    expect(first?.tools).toEqual([
      expect.objectContaining({
        name: 'search_help_center',
        description: 'The help center for travellers. Returns the best matches with a snippet each.',
      }),
    ])
    expect(JSON.stringify(first?.tools[0]?.inputSchema)).toContain('"query"')
    expect(searches).toEqual([
      {
        term: 'visa price',
        options: { page: 1, perPage: 5, highlight: { words: 40, fragments: 2 }, filter: { published: true } },
      },
    ])
    expect(toolResult(second)).toEqual({
      results: [
        { key: 'visa', title: 'Visa', snippet: 'The visa costs 35 € & is paid on arrival', metadata: { url: '/visa' } },
      ],
      total: 1,
      page: 1,
      lastPage: 1,
    })
    await app.shutdown()
  })
})

const DATABASE_URL = process.env.DATABASE_URL

describe.skipIf(!DATABASE_URL)('conversation recall (ai.recall, full text without an embedder)', () => {
  const name = `cslug_ai_recall_${process.pid}`
  const admin = new SQL(Object.assign(new URL(DATABASE_URL as string), { pathname: '/postgres' }).toString(), {
    max: 1,
  })
  afterAll(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.close()
  })
  const script = new Scripted()
  const t = testApp({
    async create() {
      await admin.unsafe(`drop database if exists "${name}" with (force)`)
      await admin.unsafe(`create database "${name}"`)
      const app = new Application({
        root: FIXTURE,
        configs: {
          database: { url: Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString() },
          ai: { default: 'script', recall: true },
        },
      }).useProviders([DatabaseProvider, SearchProvider, AiProvider])
      app.singleton(Logger, () => Logger.null())
      return app
    },
  })

  @inject()
  class TripAgent extends Agent {
    model = 'claude-haiku-5-5'
    tools = [recallTool()]
  }
  const as = <T>(userId: string, fn: () => Promise<T>) =>
    runInContext({ app: t.app, scope: t.app.createScope(), userId }, fn)

  test('an owner recalls their other conversations only; deleting a conversation forgets it', async () => {
    t.resolve(Ai).extend('script', script)
    const conversations = t.resolve(Conversations)
    script.call = undefined
    script.answer = 'Noted: Air Austral on the 12th.'
    const earlier = await as('u1', async () => {
      const c = await conversations.start(TripAgent)
      await c.send('I fly to Antananarivo with Air Austral on the 12th')
      return c
    })
    await as('u2', async () => {
      const c = await conversations.start(TripAgent)
      await c.send('I also fly with Air Austral, on the 3rd')
    })
    const docs = await t
      .resolve(Database)
      .many<{ key: string; metadata: { role: string } }>(
        sql`select key, metadata from cslug_search_documents where index = 'ai-conversations' order by key`,
      )
    expect(docs.length).toBe(4) // the user message and the answer, per conversation
    expect(docs.filter((d) => d.key.startsWith(earlier.id)).map((d) => d.metadata.role)).toEqual(['user', 'assistant'])

    script.call = { name: 'recall_conversations', input: { query: 'Air Austral' } }
    script.answer = 'You fly on the 12th.'
    const now = await as('u1', async () => {
      const c = await conversations.start(TripAgent)
      await c.send('When is my Air Austral flight?')
      return c
    })
    const { results } = toolResult(script.requests.at(-1))
    expect(results.map((r: { conversationId: string }) => r.conversationId)).toEqual([earlier.id, earlier.id])
    expect(results.map((r: { text: string }) => r.text)).toContain('I fly to Antananarivo with Air Austral on the 12th')
    expect(JSON.stringify(results)).not.toContain('the 3rd') // u2's conversation
    expect(JSON.stringify(results)).not.toContain(now.id) // the current one

    await as('u1', () => earlier.delete())
    script.requests = []
    await as('u1', () => now.send('And my flight again?'))
    expect(toolResult(script.requests.at(-1)).results).toEqual([])
  })
})
