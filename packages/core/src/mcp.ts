/**
 * The Model Context Protocol, server side, over any list of tools: `@cslug/ai` serves `@mcp()` tools with it
 * (`POST /mcp`, `cslug mcp:serve`) and `@cslug/cli` the development tools (`cslug mcp:dev`).
 */

/** Protocol versions served: 2026-07-28 (stateless, `server/discover`) and the `initialize` ones before it. */
export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']
const LEGACY = MCP_VERSIONS.slice(1)
const META = 'io.modelcontextprotocol/'

/** A tool as MCP sees it. `call` validates its arguments; what it throws becomes an error result the model reads. */
export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call(args: Record<string, unknown>): unknown
}

/** A JSON-RPC message from the client. */
export type McpMessage = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/** A JSON-RPC response. */
export type McpReply = {
  jsonrpc: string
  id: string | number | null
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

export type McpServerInfo = { name: string; version: string }

const error = (id: McpMessage['id'], code: number, message: string, data?: unknown): McpReply => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
})

/** One MCP message → its response (undefined for a notification). */
export async function handleMcpMessage(
  message: McpMessage,
  tools: readonly McpTool[],
  serverInfo: McpServerInfo = { name: 'cslug', version: '0' },
): Promise<McpReply | undefined> {
  const { id, method, params = {} } = message
  if (id === undefined || id === null) return undefined // notifications (initialized, cancelled…)
  const meta = (params._meta ?? {}) as Record<string, unknown>
  const requested = meta[`${META}protocolVersion`]
  if (typeof requested === 'string' && !MCP_VERSIONS.includes(requested))
    return error(id, -32022, 'Unsupported protocol version', { supported: MCP_VERSIONS, requested })
  const result = (value: object): McpReply => ({
    jsonrpc: '2.0',
    id,
    result: { resultType: 'complete', ...value, _meta: { [`${META}serverInfo`]: serverInfo } },
  })
  switch (method) {
    case 'server/discover':
      return result({ supportedVersions: MCP_VERSIONS, capabilities: { tools: {} } })
    case 'initialize': {
      const asked = String(params.protocolVersion ?? '')
      return result({
        protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0],
        capabilities: { tools: {} },
        serverInfo,
      })
    }
    case 'ping':
      return result({})
    case 'tools/list':
      return result({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name)
      if (!tool) return error(id, -32602, `Unknown tool: ${String(params.name)}`)
      try {
        const value = await tool.call((params.arguments ?? {}) as Record<string, unknown>)
        const plain = value !== null && typeof value === 'object' && !Array.isArray(value)
        return result({
          content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }],
          isError: false,
          ...(plain ? { structuredContent: value } : {}),
        })
      } catch (e) {
        return result({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
      }
    }
    default:
      return error(id, -32601, `Method not found: ${String(method)}`)
  }
}

/**
 * Serve MCP over stdio: one JSON-RPC message per line on stdin, replies on stdout (nothing else may write there:
 * route logs to stderr first). Returns when stdin closes.
 */
export async function serveMcpStdio(
  tools: () => readonly McpTool[] | Promise<readonly McpTool[]>,
  serverInfo: McpServerInfo,
  io: { lines: AsyncIterable<string>; write(line: string): void } = {
    lines: console,
    write: (line) => process.stdout.write(`${line}\n`),
  },
): Promise<void> {
  for await (const line of io.lines) {
    if (!line.trim()) continue
    let reply: McpReply | undefined
    try {
      reply = await handleMcpMessage(JSON.parse(line) as McpMessage, await tools(), serverInfo)
    } catch {
      reply = error(null, -32700, 'Parse error')
    }
    if (reply) io.write(JSON.stringify(reply))
  }
}
