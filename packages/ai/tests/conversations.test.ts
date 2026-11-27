import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, Clock, ConflictError, FakeClock, inject, Logger, NotFoundError, runInContext } from '@cslug/core'
import { Database, DatabaseProvider, sql } from '@cslug/database'
import { testApp } from '@cslug/testing'
import { v } from '@cslug/validation'
import { SQL } from 'bun'
import {
  Agent,
  Ai,
  AiProvider,
  Conversations,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  type StreamEvent,
} from '../src'

const FIXTURE = join(import.meta.dir, 'fixture')
const DATABASE_URL = process.env.DATABASE_URL

@inject()
class VisaAssistantAgent extends Agent {
  model = 'claude-sonnet-5-5'
  instructions = 'Answer visa questions for Madagascar.'
}

@inject()
class TripAgent extends Agent {
  model = 'claude-haiku-5-5'
  output = v.object({ nights: v.int() })
}

/** Answers "answer <n>" (or what `next` returns); `gate` holds every call until it is opened. */
class Scripted implements Provider {
  requests: ModelRequest[] = []
  gate: Promise<void> | undefined
  next: (() => string) | undefined
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request))
    await this.gate
    const text = this.next ? this.next() : `answer ${this.requests.length}`
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1000, outputTokens: 100 },
    }
  }
  async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.complete(request)
    yield { type: 'text', text: (response.content[0] as { text: string }).text }
    yield { type: 'done', response }
  }
}

const as = <T>(app: Application, userId: string | undefined, fn: () => T) =>
  runInContext({ app, scope: app.createScope(), ...(userId ? { userId } : {}) }, fn)

describe.skipIf(!DATABASE_URL)('stored conversations (@cslug/database)', () => {
  const name = `cslug_ai_${process.pid}`
  const admin = DATABASE_URL
    ? new SQL(Object.assign(new URL(DATABASE_URL), { pathname: '/postgres' }).toString(), { max: 1 })
    : undefined
  afterAll(async () => {
    await admin?.unsafe(`drop database if exists "${name}" with (force)`)
    await admin?.close()
  })
  const script = new Scripted()
  const t = testApp({
    async create() {
      await admin?.unsafe(`drop database if exists "${name}" with (force)`)
      await admin?.unsafe(`create database "${name}"`)
      const app = new Application({
        root: FIXTURE,
        configs: {
          database: { url: Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString() },
          ai: { default: 'script' },
        },
      }).useProviders([DatabaseProvider, AiProvider])
      app.singleton(Logger, () => Logger.null())
      return app
    },
  })
  const setup = () => {
    script.requests = []
    script.gate = undefined
    script.next = undefined
    t.resolve(Ai).extend('script', script)
    return t.resolve(Conversations)
  }
  const runs = () =>
    t.resolve(Database).many<{
      agent: string
      model: string
      conversationId: string | null
      userId: string | null
      status: string
      inputTokens: number
      costUsd: string | null
      error: string | null
    }>(sql`select * from cslug_ai_runs order by started_at, id`)

  test('start → send → send: each turn continues the stored history; messages and runs are recorded', async () => {
    const conversations = setup()
    const app = t.app
    const chat = await as(app, 'u1', () => conversations.start(VisaAssistantAgent, { title: 'Visa' }))
    expect(chat.owner).toEqual({ type: 'user', id: 'u1' })

    const first = await as(app, 'u1', () => chat.send('Do Italians need a visa?'))
    expect(first.value).toBe('answer 1')
    const second = await as(app, 'u1', () => chat.send('Can it be extended?'))
    expect(second.value).toBe('answer 2')

    const sent = script.requests[1] as ModelRequest
    expect(sent.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent.compact).toBe(true) // conversations ask for server-side compaction
    expect((await chat.messages()).map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'Do Italians need a visa?',
      'answer 1',
      'Can it be extended?',
      'answer 2',
    ])
    const stored = await t
      .resolve(Database)
      .many<{ position: number; runId: string }>(sql`select position, run_id from cslug_ai_messages order by position`)
    expect(stored.map((m) => m.runId)).toEqual([first.runId, first.runId, second.runId, second.runId])

    const recorded = await runs()
    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({
      agent: 'VisaAssistantAgent',
      model: 'claude-sonnet-5-5',
      conversationId: chat.id,
      userId: 'u1',
      status: 'completed',
      inputTokens: 1000,
    })
    expect(Number(recorded[0]?.costUsd)).toBeCloseTo(0.003) // 1000 × $2 + 100 × $10 per million
  })

  test('find: the owner only (NotFoundError otherwise), the right agent; explicit owners; unowned conversations', async () => {
    const conversations = setup()
    const app = t.app
    const chat = await as(app, 'u1', () => conversations.start(VisaAssistantAgent))
    expect((await as(app, 'u1', () => conversations.find(VisaAssistantAgent, chat.id))).id).toBe(chat.id)
    for (const attempt of [
      () => as(app, 'u2', () => conversations.find(VisaAssistantAgent, chat.id)),
      () => as(app, undefined, () => conversations.find(VisaAssistantAgent, chat.id)),
      () => as(app, 'u1', () => conversations.find(TripAgent, chat.id)),
      () => as(app, 'u1', () => conversations.find(VisaAssistantAgent, 'not-a-uuid')),
    ])
      expect(attempt()).rejects.toBeInstanceOf(NotFoundError)
    // a job has no signed-in user: it names the owner
    expect((await conversations.find(VisaAssistantAgent, chat.id, { owner: { id: 'u1' } })).id).toBe(chat.id)

    const team = await conversations.start(VisaAssistantAgent, { owner: { id: 42 }, ownerType: 'team' })
    expect(as(app, '42', () => conversations.find(VisaAssistantAgent, team.id))).rejects.toBeInstanceOf(NotFoundError)
    expect((await conversations.find(VisaAssistantAgent, team.id, { owner: { id: 42 }, ownerType: 'team' })).id).toBe(
      team.id,
    )

    const open = await as(app, undefined, () => conversations.start(VisaAssistantAgent))
    expect(open.owner).toBeNull()
    expect((await as(app, 'u9', () => conversations.find(VisaAssistantAgent, open.id))).id).toBe(open.id)
  })

  test('list: the owner’s conversations, most recent first, optionally for one agent', async () => {
    const conversations = setup()
    const app = t.app
    const clock = new FakeClock('UTC', '2026-11-27T10:00:00Z')
    app.swap(Clock, clock)
    const a = await as(app, 'u1', () => conversations.start(VisaAssistantAgent, { title: 'a' }))
    clock.advance('1m')
    const b = await as(app, 'u1', () => conversations.start(TripAgent, { title: 'b', metadata: { trip: 'T1' } }))
    await as(app, 'u2', () => conversations.start(VisaAssistantAgent))
    clock.advance('1m')
    await as(app, 'u1', () => a.send('hello')) // a is now the most recent
    const mine = await as(app, 'u1', () => conversations.list())
    expect(mine.map((c) => [c.title, c.messageCount])).toEqual([
      ['a', 2],
      ['b', 0],
    ])
    expect(mine[1]?.metadata).toEqual({ trip: 'T1' })
    expect((await as(app, 'u1', () => conversations.list({ agent: TripAgent }))).map((c) => c.id)).toEqual([b.id])
    expect(await as(app, undefined, () => conversations.list())).toEqual([])
  })

  test('stream: the text, then the turn is stored; structured output keeps its type', async () => {
    const conversations = setup()
    script.next = () => '{"nights": 4}'
    const chat = await conversations.start(TripAgent, { owner: null })
    const stream = chat.stream('How many nights in Isalo?')
    let text = ''
    for await (const piece of stream) text += piece
    expect(text).toBe('{"nights": 4}')
    const result = await stream.result
    expect(result.value.nights).toBe(4)
    expect(await chat.messages()).toHaveLength(2)
  })

  test('two turns at once: the second to finish is a ConflictError, nothing interleaves', async () => {
    const conversations = setup()
    const chat = await conversations.start(VisaAssistantAgent, { owner: null })
    let open = () => {}
    script.gate = new Promise((resolve) => {
      open = resolve
    })
    const one = chat.send('one')
    const two = (await conversations.find(VisaAssistantAgent, chat.id)).send('two')
    await Bun.sleep(10)
    open()
    const outcomes = await Promise.allSettled([one, two])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const failed = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toBeInstanceOf(ConflictError)
    expect(await chat.messages()).toHaveLength(2)
  })

  test('a failed run is recorded; update and delete (messages go, run records stay unlinked)', async () => {
    const conversations = setup()
    const chat = await conversations.start(VisaAssistantAgent, { owner: null })
    script.next = () => {
      throw new Error('provider down')
    }
    expect(chat.send('x')).rejects.toThrow('provider down')
    await Bun.sleep(5)
    expect((await runs()).at(-1)).toMatchObject({ status: 'failed', error: 'provider down', conversationId: chat.id })

    script.next = undefined
    await chat.send('y')
    await chat.update({ title: 'Renamed', metadata: { lang: 'it' } })
    const reloaded = await conversations.find(VisaAssistantAgent, chat.id)
    expect([reloaded.title, reloaded.metadata]).toEqual(['Renamed', { lang: 'it' }])
    await chat.delete()
    expect(conversations.find(VisaAssistantAgent, chat.id)).rejects.toBeInstanceOf(NotFoundError)
    expect(await t.resolve(Database).value(sql`select count(*)::int from cslug_ai_messages`)).toBe(0)
    expect((await runs()).every((r) => r.conversationId === null)).toBe(true)
  })

  test('runs outside conversations are recorded too, with the signed-in user', async () => {
    setup()
    await as(t.app, 'u3', () => t.resolve(TripAgent).run({ input: 'x' })).catch(() => {}) // not JSON: failed
    expect((await runs()).at(-1)).toMatchObject({
      agent: 'TripAgent',
      userId: 'u3',
      status: 'failed',
      conversationId: null,
    })
  })
})

describe('without @cslug/database', () => {
  test('conversations say what is missing; runs are not recorded', async () => {
    const app = new Application({ root: FIXTURE, configs: { ai: { default: 'script' } } }).useProviders([AiProvider])
    app.singleton(Logger, () => Logger.null())
    await app.start()
    expect(app.resolve(Ai).recorder).toBeUndefined()
    expect(app.resolve(Conversations).start(VisaAssistantAgent)).rejects.toThrow(
      'Stored conversations need @cslug/database',
    )
    await app.shutdown()
  })
})
