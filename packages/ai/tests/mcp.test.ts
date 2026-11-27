import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, inject, Logger, resolve, runInContext } from '@cslug/core'
import { API_MIDDLEWARE, HttpKernel, HttpProvider, type MiddlewareFn } from '@cslug/http'
import {
  Agent,
  Ai,
  AiProvider,
  handleMcp,
  type McpCaller,
  McpConnection,
  type ModelRequest,
  type ModelResponse,
  mcp,
  type Provider,
  type StreamEvent,
} from '../src'
import { BookingStatusTool, CircuitListTool } from './fixture/app/tools/booking-tools'

const FIXTURE = join(import.meta.dir, 'fixture')
// the decorators ran on import; keep the classes referenced
void [BookingStatusTool, CircuitListTool]

const anonymous: McpCaller = { check: () => false, tokenCan: () => false }
const token = (abilities: string[]): McpCaller => ({
  check: () => true,
  guard: 'token',
  tokenCan: (a) => abilities.includes(a),
})
const ask = (method: string, params: Record<string, unknown> = {}, caller: McpCaller | 'local' = 'local') =>
  handleMcp({ jsonrpc: '2.0', id: 1, method, params }, (cls) => resolve(cls), caller)

describe('the MCP server (2026-07-28 and 2025-11-25)', async () => {
  const app = new Application({ root: FIXTURE }).useProviders([AiProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  const run = <T>(fn: () => T) => runInContext({ app, scope: app.createScope() }, fn)

  test('server/discover, initialize (version negotiated), notifications, unknown methods and versions', async () => {
    const discover = await run(() => ask('server/discover'))
    expect(discover?.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'cslug' } },
    })
    expect((await run(() => ask('initialize', { protocolVersion: '2025-06-18' })))?.result?.protocolVersion).toBe(
      '2025-06-18',
    )
    expect((await run(() => ask('initialize', { protocolVersion: '2099-01-01' })))?.result?.protocolVersion).toBe(
      '2025-11-25',
    )
    expect(
      await run(() => handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, resolve, 'local')),
    ).toBeUndefined()
    expect((await run(() => ask('resources/list')))?.error?.code).toBe(-32601)
    const version = await run(() =>
      ask('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } }),
    )
    expect(version?.error).toMatchObject({ code: -32022, data: { requested: '1999-01-01' } })
  })

  test('tools/list: what the caller may see (public; a token with the ability; local stdio sees all exposed)', async () => {
    const names = async (caller: McpCaller | 'local') =>
      (((await run(() => ask('tools/list', {}, caller)))?.result?.tools ?? []) as { name: string }[]).map((t) => t.name)
    expect(await names(anonymous)).toEqual(['circuits'])
    expect(await names(token([]))).toEqual(['circuits'])
    expect(await names(token(['mcp:bookings']))).toEqual(['booking_status', 'circuits'])
    expect(await names('local')).toEqual(['booking_status', 'circuits'])
    const [status] = ((await run(() => ask('tools/list')))?.result?.tools ?? []) as { inputSchema: object }[]
    expect(status?.inputSchema).toMatchObject({ type: 'object', properties: { ref: { type: 'string' } } })
  })

  test('tools/call: structured result; invalid arguments and thrown errors are isError results; hidden is unknown', async () => {
    const ok = await run(() => ask('tools/call', { name: 'booking_status', arguments: { ref: 'ALB-1' } }))
    expect(ok?.result).toMatchObject({
      content: [{ type: 'text', text: '{"ref":"ALB-1","status":"deposit_paid"}' }],
      isError: false,
      structuredContent: { ref: 'ALB-1', status: 'deposit_paid' },
    })
    const invalid = await run(() => ask('tools/call', { name: 'booking_status', arguments: { ref: 'x' } }))
    expect(invalid?.result).toMatchObject({ isError: true })
    const thrown = await run(() => ask('tools/call', { name: 'booking_status', arguments: { ref: 'BOOM' } }))
    expect(thrown?.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'ledger unavailable' }] })
    const hidden = await run(() =>
      ask('tools/call', { name: 'booking_status', arguments: { ref: 'ALB-1' } }, anonymous),
    )
    expect(hidden?.error).toMatchObject({ code: -32602, message: 'Unknown tool: booking_status' })
    expect((await run(() => ask('tools/call', { name: 'internal' })))?.error?.code).toBe(-32602)
  })
})

/** Stand-in for @cslug/auth in the api group: `Authorization: Bearer <abilities>` signs in a token. */
const fakeTokens: MiddlewareFn = (ctx, next) => {
  const bearer = ctx.request.header('authorization')?.replace(/^Bearer /, '')
  Reflect.set(ctx, 'auth', bearer ? token(bearer.split(',')) : { check: () => false, tokenCan: () => false })
  return next()
}

describe('POST /mcp and the MCP client', async () => {
  const app = new Application({
    root: FIXTURE,
    configs: { app: { url: 'http://127.0.0.1', key: 'k'.repeat(32), env: 'test' } },
  }).useProviders([HttpProvider, AiProvider])
  app.singleton(Logger, () => Logger.null())
  app.instance('fake-tokens' as never, fakeTokens as never)
  app.tag(['fake-tokens' as never], API_MIDDLEWARE)
  await app.start()
  const kernel = app.resolve(HttpKernel).compile()
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => kernel.handle(req) })
  })
  afterAll(async () => {
    server.stop(true)
    await app.resolve(Ai).close()
  })
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    kernel.handle(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
      }),
    )

  test('HTTP: JSON responses, 202 for notifications, 404 for unknown methods, 405 for GET, 403 for a foreign Origin', async () => {
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer mcp:bookings' })
    expect(list.headers.get('content-type')).toContain('application/json')
    expect(((await list.json()).result.tools as { name: string }[]).map((t) => t.name)).toEqual([
      'booking_status',
      'circuits',
    ])
    const anonymous = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
    expect(anonymous.result.tools.map((t: { name: string }) => t.name)).toEqual(['circuits'])
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'nope' })).status).toBe(404)
    expect((await kernel.handle(new Request('http://127.0.0.1/mcp'))).status).toBe(405)
    expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { origin: 'https://evil.test' })).status).toBe(
      403,
    )
  })

  test('the client over HTTP (server/discover succeeds: the 2026-07-28 protocol)', async () => {
    const connection = new McpConnection('self', {
      url: `${server.url.origin}/mcp`,
      headers: { authorization: 'Bearer mcp:bookings' },
    })
    const tools = (await connection.request('tools/list')).tools as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['booking_status', 'circuits'])
    const called = await connection.request('tools/call', { name: 'circuits', arguments: {} })
    expect(called.content).toEqual([{ type: 'text', text: '["Isalo","Tsingy"]' }])
  })

  test('the client falls back to initialize with an older server (session id and version header kept)', async () => {
    const seen: { method: string; version: string | null; session: string | null }[] = []
    const legacy = Bun.serve({
      port: 0,
      async fetch(req) {
        const message = (await req.json()) as { id?: number; method: string }
        seen.push({
          method: message.method,
          version: req.headers.get('mcp-protocol-version'),
          session: req.headers.get('mcp-session-id'),
        })
        if (message.id === undefined) return new Response(null, { status: 202 })
        if (message.method === 'initialize')
          return Response.json(
            {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'old', version: '1' },
              },
            },
            { headers: { 'mcp-session-id': 's-1' } },
          )
        if (message.method === 'tools/list')
          return new Response(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}\n\n`,
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          )
        return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
      },
    })
    const connection = new McpConnection('old', { url: legacy.url.toString() })
    expect((await connection.request('tools/list')).tools).toEqual([])
    legacy.stop(true)
    expect(seen).toEqual([
      { method: 'server/discover', version: '2026-07-28', session: null },
      { method: 'initialize', version: null, session: null },
      { method: 'notifications/initialized', version: '2025-06-18', session: 's-1' },
      { method: 'tools/list', version: '2025-06-18', session: 's-1' },
    ])
  })

  test('the client over stdio: cslug mcp:serve as a child process', async () => {
    const connection = new McpConnection('stdio', { command: [process.execPath, join(FIXTURE, 'stdio-server.ts')] })
    try {
      const tools = (await connection.request('tools/list')).tools as { name: string }[]
      expect(tools.map((t) => t.name)).toEqual(['booking_status', 'circuits']) // local: every exposed tool
      const status = await connection.request('tools/call', { name: 'booking_status', arguments: { ref: 'ALB-7' } })
      expect(status.structuredContent).toEqual({ ref: 'ALB-7', status: 'deposit_paid' })
    } finally {
      await connection.close()
    }
  })

  test("an agent uses a server's tools: mcp('self').tools(['booking_status'])", async () => {
    class Scripted implements Provider {
      readonly requests: ModelRequest[] = []
      private step = 0
      async complete(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(structuredClone(request))
        return this.step++ === 0
          ? {
              content: [{ type: 'tool_use', id: 't', name: 'booking_status', input: { ref: 'ALB-9' } }],
              stopReason: 'tool_use',
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          : {
              content: [{ type: 'text', text: 'Paid.' }],
              stopReason: 'end_turn',
              usage: { inputTokens: 0, outputTokens: 0 },
            }
      }
      async *stream(): AsyncIterable<StreamEvent> {}
    }
    @inject()
    class StatusAgent extends Agent {
      model = 'm'
      provider = 'script'
      tools = [...mcp('self').tools(['booking_status'])]
    }
    const ai = new Ai(
      app,
      { mcp: { self: { url: `${server.url.origin}/mcp`, headers: { authorization: 'Bearer mcp:bookings' } } } },
      Logger.null(),
    )
    const script = new Scripted()
    ai.extend('script', script)
    app.swap(Ai, ai)
    try {
      const answer = await runInContext({ app, scope: app.createScope() }, () =>
        new StatusAgent().run({ input: 'ALB-9?' }),
      )
      expect(answer).toBe('Paid.')
      expect(script.requests[0]?.tools.map((t) => t.name)).toEqual(['booking_status'])
      expect(script.requests[1]?.messages.at(-1)?.content).toEqual([
        { type: 'tool_result', toolUseId: 't', content: '{"ref":"ALB-9","status":"deposit_paid"}', isError: false },
      ])
    } finally {
      app.restoreSwaps()
      await ai.close()
    }
  })
})
