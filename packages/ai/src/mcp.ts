import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Application } from '@cslug/core'
import type { Tool, ToolClass } from './agent'

/** Protocol versions served: 2026-07-28 (stateless, `server/discover`) and the `initialize` ones before it. */
export const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']
const LEGACY = MCP_VERSIONS.slice(1)
const META = 'io.modelcontextprotocol/'

/**
 * Who may call an exposed tool over HTTP. Default: an authenticated caller (any guard); `public: true` exposes it
 * to anyone; `guard` requires one guard; `ability` an API-token ability (session users pass, as with `ability()`).
 */
export type McpOptions = { public?: boolean; guard?: string; ability?: string }

const exposed = new Map<ToolClass, McpOptions>()

/** `@mcp({ ability: 'mcp:bookings' })` on a `Tool` class: served by `/mcp` and `cslug mcp:serve`. */
export const exposeMcp =
  (options: McpOptions = {}) =>
  <C extends ToolClass>(cls: C, _context?: ClassDecoratorContext): C => {
    exposed.set(cls, options)
    return cls
  }

/** The tools marked with `@mcp()` (after `discoverTools` imported `app/tools/`). */
export const mcpTools = (): [ToolClass, McpOptions][] => [...exposed]

/** Import every module under `app/tools/`, so their `@mcp()` decorators run. */
export async function discoverTools(app: Application): Promise<void> {
  const dir = join(app.rootDir, 'app/tools')
  if (!existsSync(dir)) return
  for (const file of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /(?<!\.test)\.ts$/.test(f)))
    await import(join(dir, file))
}

/** The caller as the HTTP route sees it: `ctx.auth` when @cslug/auth is installed. */
export type McpCaller = { check(): boolean; guard?: string; tokenCan(ability: string): boolean } | undefined

const allowed = (options: McpOptions, caller: McpCaller | 'local') =>
  caller === 'local' ||
  options.public === true ||
  (!!caller?.check() &&
    (!options.guard || caller.guard === options.guard) &&
    (!options.ability || caller.tokenCan(options.ability)))

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
/** A JSON-RPC response. */
export type McpReply = {
  jsonrpc: string
  id: string | number | null
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}
const error = (id: Rpc['id'], code: number, message: string, data?: unknown): McpReply => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, ...(data === undefined ? {} : { data }) },
})

/**
 * One MCP message → its response (undefined for a notification). `tools` builds the exposed tools; `caller` is who
 * is asking (`'local'` for stdio: every exposed tool).
 */
export async function handleMcp(
  message: Rpc,
  tools: (cls: ToolClass) => Tool,
  caller: McpCaller | 'local',
  serverInfo = { name: 'cslug', version: '0' },
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
  const visible = mcpTools().filter(([, options]) => allowed(options, caller))
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
      return result({
        tools: visible.map(([cls]) => {
          const t = tools(cls)
          return { name: t.name, description: t.description, inputSchema: t.input.toJSONSchema() }
        }),
      })
    case 'tools/call': {
      const tool = visible.map(([cls]) => tools(cls)).find((t) => t.name === params.name)
      if (!tool) return error(id, -32602, `Unknown tool: ${String(params.name)}`)
      const input = tool.input.safeParse(params.arguments ?? {})
      const text = (value: string, isError = false) => result({ content: [{ type: 'text', text: value }], isError })
      if (!input.success) return text(`Invalid arguments: ${JSON.stringify(input.error.issues)}`, true)
      try {
        const value = await tool.handle(input.data as never)
        const plain = value !== null && typeof value === 'object' && !Array.isArray(value)
        return result({
          content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }],
          isError: false,
          ...(plain ? { structuredContent: value } : {}),
        })
      } catch (e) {
        return text(e instanceof Error ? e.message : String(e), true)
      }
    }
    default:
      return error(id, -32601, `Method not found: ${String(method)}`)
  }
}
