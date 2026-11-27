import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type Application, handleMcpMessage, type McpMessage, type McpReply, type McpTool } from '@cslug/core'
import type { Tool, ToolClass } from './agent'

export { MCP_VERSIONS, type McpReply } from '@cslug/core'

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

/**
 * One MCP message → its response (undefined for a notification). `tools` builds the exposed tools; `caller` is who
 * is asking (`'local'` for stdio: every exposed tool).
 */
export async function handleMcp(
  message: McpMessage,
  tools: (cls: ToolClass) => Tool,
  caller: McpCaller | 'local',
  serverInfo = { name: 'cslug', version: '0' },
): Promise<McpReply | undefined> {
  return handleMcpMessage(message, asMcpTools(tools, caller), serverInfo)
}

/** The `@mcp()` tools `caller` may use, as MCP tools (arguments validated with the tool's schema). */
export function asMcpTools(tools: (cls: ToolClass) => Tool, caller: McpCaller | 'local'): McpTool[] {
  return mcpTools()
    .filter(([, options]) => allowed(options, caller))
    .map(([cls]) => {
      const tool = tools(cls)
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input.toJSONSchema() as Record<string, unknown>,
        call: (args) => {
          const input = tool.input.safeParse(args)
          if (!input.success) throw new Error(`Invalid arguments: ${JSON.stringify(input.error.issues)}`)
          return tool.handle(input.data as never)
        },
      }
    })
}
