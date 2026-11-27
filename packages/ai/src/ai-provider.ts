import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, flag, Logger, resolve, ServiceProvider, serveMcpStdio, type Token } from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { PROMPT_VARIABLE } from './agent'
import { Ai, type AiConfig } from './ai'
import { AiEvalCommand } from './ai-eval-command'
import { databaseStore } from './conversation-store'
import { Conversations } from './conversations'
import { embedderFor, type TextEmbedder } from './embedders'
import { setFakeEmbedder } from './fake'
import { asMcpTools, discoverTools, handleMcp, type McpCaller, type McpReply, mcpTools } from './mcp'
import type { SearchableIndex } from './search-tools'

/** What this package uses of @cslug/search (an optional peer, imported only when installed). */
type SearchModule = {
  Embedder: Token<TextEmbedder>
  FakeEmbedder: new () => TextEmbedder
  SearchIndex: new (name: string, options: { semantic?: boolean }) => SearchableIndex
}

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
    await serveMcpStdio(() => asMcpTools((cls) => resolve(cls), 'local'), info)
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
              ...new Set(
                [...readFileSync(join(dir, f), 'utf8').matchAll(PROMPT_VARIABLE)].map((m) =>
                  m[2] === undefined ? m[1] : `${m[1]}?`,
                ),
              ),
            ].join(', '),
          }))
      : []
    if (json) this.line(JSON.stringify(rows))
    else if (rows.length) this.table(rows)
    else this.info('No prompts in resources/prompts')
  }
}

/**
 * `cslug ai:record [path]`: `bun test` with `t.ai.fixture()` answered by the real provider; missing fixtures are
 * written (`--all`: every one, re-recorded). Each recorded call costs what the model charges.
 */
export class AiRecordCommand extends Command {
  static signature = 'ai:record'
  static description = 'Run tests against the real AI provider and write their missing fixtures (calls the API)'
  static boot = false
  static args = {
    path: arg.string().optional().describe('A test file or folder (bun test filter)'),
    all: flag.boolean().describe('Re-record every fixture the tests use'),
  }

  async handle({ path, all }: Command.Args<typeof AiRecordCommand>) {
    this.warn(`Recording AI fixtures (${all ? 'all' : 'missing'}): the real provider is called`)
    const child = Bun.spawn(['bun', 'test', ...(path ? [path] : [])], {
      cwd: this.app.rootDir,
      env: { ...process.env, CSLUG_AI_RECORD: all ? 'all' : 'missing' },
      stdio: ['inherit', 'inherit', 'inherit'],
    })
    return await child.exited
  }
}

/**
 * Binds `Ai` from `config/ai.ts` (`default`, `providers`, `models`, `mcp`, `budget`, `prices`, `runs`,
 * `embeddings`: @cslug/search's `Embedder` when it is installed) and
 * `Conversations`; contributes `ai:prompts`, `ai:record`, `ai:eval` and `mcp:serve`. With @cslug/database: the
 * `cslug_ai_*` tables, stored conversations and a record per run.
 * With `@mcp()` tools in `app/tools/` and @cslug/http installed: `POST /mcp` (streamable HTTP, in the api group's
 * middleware, so API tokens authenticate callers).
 */
export class AiProvider extends ServiceProvider {
  register() {
    this.commands([AiPromptsCommand, AiRecordCommand, AiEvalCommand, McpServeCommand])
    this.app.singleton(
      Ai,
      (c) => new Ai(this.app, this.app.config<AiConfig | undefined>('ai') ?? {}, c.resolve(Logger)),
    )
    this.app.singleton(Conversations, () => new Conversations(this.app))
  }

  async boot() {
    await this.bindEmbedder()
    await this.recallIndex()
    const store = await databaseStore(this.app)
    if (store) {
      this.app.resolve(Conversations).store = store
      if (this.app.config<boolean | undefined>('ai.runs') !== false) this.app.resolve(Ai).recorder = store.recordRun
    }
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

  /** With `ai.embeddings` and @cslug/search installed: its `Embedder`, from the configured driver. */
  private async bindEmbedder() {
    const config = this.app.config<AiConfig | undefined>('ai')?.embeddings
    if (!config) return
    // a variable specifier: apps without @cslug/search still type-check (TypeScript does not resolve it)
    const specifier = '@cslug/search'
    const search = (await import(specifier).catch(() => undefined)) as SearchModule | undefined
    if (!search) {
      this.app.resolve(Logger).warn('ai.embeddings_unused', { reason: '@cslug/search is not installed' })
      return
    }
    const embedder = embedderFor(config, () => this.app.resolve(Ai).budget)
    this.app.instance(search.Embedder, embedder)
    // tests (`fakes: ['ai']`) swap it for a FakeEmbedder: no paid call from a test
    setFakeEmbedder(search.Embedder, () => new search.FakeEmbedder())
  }

  /** With `ai.recall`: the index conversations' turns are kept in (semantic when an embedder is bound). */
  private async recallIndex() {
    const recall = this.app.config<AiConfig | undefined>('ai')?.recall
    if (!recall) return
    const specifier = '@cslug/search'
    const search = (await import(specifier).catch(() => undefined)) as SearchModule | undefined
    if (!search) {
      this.app.resolve(Logger).warn('ai.recall_unused', { reason: '@cslug/search is not installed' })
      return
    }
    const name = (typeof recall === 'object' && recall.index) || 'ai-conversations'
    this.app.resolve(Ai).recallIndex = new search.SearchIndex(name, { semantic: this.app.has(search.Embedder) })
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
