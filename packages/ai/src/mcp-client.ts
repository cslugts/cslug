import { CslugError } from '@cslug/core'
import { exposeMcp, type McpOptions } from './mcp'
import { sseEvents } from './model'

/** `config/ai.ts` → `mcp.<name>`: a streamable HTTP endpoint, or a command speaking MCP on stdio. */
export type McpServerConfig =
  | { url: string; headers?: Record<string, string> }
  | { command: string[]; env?: Record<string, string> }

const MODERN = '2026-07-28'
const LEGACY = '2025-11-25'
const CLIENT = { name: 'cslug', version: '0' }
type Reply = { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }

/** One connection to an MCP server: the version is probed (`server/discover`, else `initialize`) on first use. */
export class McpConnection {
  private version?: string
  private session?: string
  private nextId = 1
  private proc?: Bun.Subprocess<'pipe', 'pipe', 'inherit'>
  private readonly waiting = new Map<number, (reply: Reply) => void>()

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  /** A request; a JSON-RPC error is an `ai.mcp` error. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.version) await this.connect()
    const reply = await this.send(method, params)
    if (reply?.error) throw new CslugError('ai.mcp', `${this.name}: ${reply.error.message} (${reply.error.code})`)
    return reply?.result ?? {}
  }

  private async connect() {
    this.version = MODERN
    const discovered = await this.send('server/discover', {}).catch(() => undefined)
    if ((discovered?.result?.supportedVersions as string[] | undefined)?.includes(MODERN)) return
    this.version = undefined // an older server: the initialize handshake
    const init = await this.send('initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: CLIENT })
    if (!init?.result) throw new CslugError('ai.mcp', `${this.name}: initialize failed (${init?.error?.message})`)
    this.version = String(init.result.protocolVersion)
    await this.send('notifications/initialized', undefined)
  }

  private async send(method: string, params: Record<string, unknown> | undefined): Promise<Reply | undefined> {
    const notification = method.startsWith('notifications/')
    const id = notification ? undefined : this.nextId++
    const modern = this.version === MODERN
    const meta = modern
      ? {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': CLIENT,
          },
        }
      : {}
    const message = {
      jsonrpc: '2.0',
      ...(id ? { id } : {}),
      method,
      ...(params || modern ? { params: { ...params, ...meta } } : {}),
    }
    return 'url' in this.config ? this.http(message, id) : this.stdio(message, id)
  }

  private async http(message: { method: string; params?: Record<string, unknown> }, id?: number) {
    const config = this.config as { url: string; headers?: Record<string, string> }
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': message.method,
        ...(this.version ? { 'mcp-protocol-version': this.version } : {}),
        ...(message.method === 'tools/call' ? { 'mcp-name': String(message.params?.name) } : {}),
        ...(this.session ? { 'mcp-session-id': this.session } : {}),
        ...config.headers,
      },
      body: JSON.stringify(message),
    })
    this.session = res.headers.get('mcp-session-id') ?? this.session
    if (id === undefined || res.status === 202) return undefined
    if (!res.ok && !res.headers.get('content-type')?.includes('json'))
      throw new CslugError('ai.mcp', `${this.name} answered ${res.status}`)
    if (!res.headers.get('content-type')?.includes('event-stream')) return (await res.json()) as Reply
    for await (const { data } of sseEvents(res.body as ReadableStream<Uint8Array>)) {
      const reply = JSON.parse(data) as Reply
      if (reply.id === id) return reply
    }
    throw new CslugError('ai.mcp', `${this.name}: the stream ended without a response`)
  }

  private async stdio(message: object, id?: number) {
    const proc = this.proc ?? this.spawn()
    const reply = id === undefined ? undefined : new Promise<Reply>((done) => this.waiting.set(id, done))
    proc.stdin.write(`${JSON.stringify(message)}\n`)
    await proc.stdin.flush()
    return reply
  }

  private spawn() {
    const { command, env } = this.config as { command: string[]; env?: Record<string, string> }
    const proc = Bun.spawn(command, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, ...env },
    })
    this.proc = proc
    void (async () => {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        buffer += decoder.decode(read.value, { stream: true })
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end).trim()
          buffer = buffer.slice(end + 1)
          const reply = line ? (JSON.parse(line) as Reply) : undefined
          if (typeof reply?.id === 'number') this.waiting.get(reply.id)?.(reply)
        }
      }
    })()
    return proc
  }

  async close(): Promise<void> {
    this.proc?.stdin.end()
    this.proc?.kill()
    await this.proc?.exited
    this.proc = undefined
  }
}

/** The tools of an MCP server (all, or the `only` names), for an agent's `tools`. */
export class McpTools {
  constructor(
    readonly server: string,
    readonly only?: readonly string[],
  ) {}
}

/**
 * `mcp('maps').tools(['route_duration'])`: an MCP server's tools for an agent (spread into `tools`).
 * `@mcp({ ability })`: expose a `Tool` class over MCP.
 */
export function mcp(server: string): { tools(only?: readonly string[]): McpTools[] }
export function mcp(options?: McpOptions): ReturnType<typeof exposeMcp>
export function mcp(arg?: string | McpOptions) {
  return typeof arg === 'string' ? { tools: (only?: readonly string[]) => [new McpTools(arg, only)] } : exposeMcp(arg)
}
