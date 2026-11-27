import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Command, flag, Logger, resolve, ServiceProvider } from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { Ai, type AiConfig } from './ai'
import { discoverTools, handleMcp, type McpCaller, type McpReply, mcpTools } from './mcp'

/**
 * `cslug mcp:serve`: the `@mcp()` tools over stdio, for a local client (every exposed tool: the caller is whoever
 * runs the command). Logs go to stderr; stdout carries only MCP messages.
 */
export class McpServeCommand extends Command {
  static signature = 'mcp:serve'
  static description = 'Serve the @mcp() tools over stdio (HTTP: POST /mcp on the web server)'

  async handle() {
    this.app.swap(Logger, new Logger({ write: (line) => process.stderr.write(`${line}\n`) }))
    const info = { name: String(this.app.config('app.name') ?? 'cslug'), version: '1' }
    for await (const line of console) {
      if (!line.trim()) continue
      let reply: McpReply | undefined
      try {
        reply = await handleMcp(JSON.parse(line), (cls) => resolve(cls), 'local', info)
      } catch {
        reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
      }
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
    }
    return 0
  }
}

/** `cslug ai:prompts`: the prompt files and the variables each one needs. */
export class AiPromptsCommand extends Command {
  static signature = 'ai:prompts'
  static description = 'List resources/prompts/*.md and their {{ variables }}'
  static boot = false
  static args = { json: flag.boolean() }

  handle({ json }: Command.Args<typeof AiPromptsCommand>) {
    const dir = join(this.app.rootDir, 'resources/prompts')
    const rows = existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[])
          .filter((f) => f.endsWith('.md'))
          .sort()
          .map((f) => ({
            prompt: f.replace(/\.md$/, ''),
            variables: [
              ...new Set([...readFileSync(join(dir, f), 'utf8').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])),
            ].join(', '),
          }))
      : []
    if (json) this.line(JSON.stringify(rows))
    else if (rows.length) this.table(rows)
    else this.info('No prompts in resources/prompts')
  }
}

/**
 * Binds `Ai` from `config/ai.ts` (`default`, `providers`, `models`, `mcp`); contributes `ai:prompts` and `mcp:serve`.
 * With `@mcp()` tools in `app/tools/` and @cslug/http installed: `POST /mcp` (streamable HTTP, in the api group's
 * middleware, so API tokens authenticate callers).
 */
export class AiProvider extends ServiceProvider {
  register() {
    this.commands([AiPromptsCommand, McpServeCommand])
    this.app.singleton(
      Ai,
      (c) => new Ai(this.app, this.app.config<AiConfig | undefined>('ai') ?? {}, c.resolve(Logger)),
    )
  }

  async boot() {
    await discoverTools(this.app)
    if (!mcpTools().length) return
    const http = await import('@cslug/http').catch(() => undefined)
    if (!http || !this.app.has(http.Router)) return
    const info = { name: String(this.app.config('app.name') ?? 'cslug'), version: '1' }
    this.app.resolve(http.Router).load(
      (r) => {
        r.post('/mcp', (ctx) => this.mcpHttp(ctx, info)).name('mcp')
        r.get('/mcp', () => new Response(null, { status: 405, headers: { allow: 'POST' } }))
      },
      { middleware: this.app.tagged(http.API_MIDDLEWARE) },
    )
  }

  /** One MCP message over HTTP: Origin checked (DNS rebinding), notifications 202, JSON responses. */
  private async mcpHttp(ctx: HttpContext, info: { name: string; version: string }): Promise<Response> {
    const origin = ctx.request.header('origin')
    const appUrl = this.app.config<string | undefined>('app.url')
    if (origin && (!appUrl || new URL(origin).origin !== new URL(appUrl).origin))
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } },
        { status: 403 },
      )
    const caller: McpCaller = Reflect.get(ctx, 'auth')
    const reply = await handleMcp(await ctx.request.body(), (cls) => resolve(cls), caller, info).catch(
      (): McpReply => ({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    )
    if (!reply) return new Response(null, { status: 202 })
    return Response.json(reply, { status: reply.error?.code === -32601 ? 404 : 200 })
  }

  async shutdown() {
    await this.app.resolve(Ai).close()
  }
}
