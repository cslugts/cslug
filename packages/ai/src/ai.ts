import { type Application, CslugError, type Logger, resolve } from '@cslug/core'
import type { AgentSettings, RunnableTool, RunOptions } from './agent'
import {
  type AnthropicConfig,
  AnthropicProvider,
  type OpenAiCompatibleConfig,
  OpenAiCompatibleProvider,
} from './drivers'
import { McpConnection, type McpServerConfig, McpTools } from './mcp-client'
import { type Block, type ModelRequest, type ModelResponse, modelSchema, type Provider } from './model'

/** `config/ai.ts`. */
export type AiConfig = {
  default?: string
  providers?: Record<string, AnthropicConfig | OpenAiCompatibleConfig>
  /** Roles code refers to (`fast`, `smart`) → model IDs. */
  models?: Record<string, string>
  /** MCP servers whose tools agents use: `mcp('maps').tools([...])`. */
  mcp?: Record<string, McpServerConfig>
}

/** The model's final answer did not match the agent's `output` schema (or was not JSON). */
export class AiOutputError extends CslugError {
  constructor(
    readonly text: string,
    readonly issues: unknown,
  ) {
    super('ai.output', `The model's answer does not match the output schema: ${JSON.stringify(issues).slice(0, 300)}`)
  }
}

const textOf = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')

/** Runs agents: renders instructions, calls the provider, runs tools until the model answers, validates the output. */
export class Ai {
  private readonly providers = new Map<string, Provider>()
  private readonly connections = new Map<string, McpConnection>()

  constructor(
    protected readonly app: Application,
    protected readonly config: AiConfig,
    protected readonly log: Logger,
  ) {}

  /** Register a provider by name (tests, custom APIs). */
  extend(name: string, provider: Provider): this {
    this.providers.set(name, provider)
    return this
  }

  provider(name = this.config.default ?? 'anthropic'): Provider {
    const known = this.providers.get(name)
    if (known) return known
    const config =
      this.config.providers?.[name] ?? (name === 'anthropic' ? { driver: 'anthropic' as const } : undefined)
    if (!config) throw new CslugError('ai.unknown_provider', `No AI provider "${name}" (config ai.providers)`)
    const provider =
      config.driver === 'anthropic' ? new AnthropicProvider(config) : new OpenAiCompatibleProvider(config)
    this.providers.set(name, provider)
    return provider
  }

  /** An MCP server's tools as a run calls them (its result: `structuredContent`, else the text). */
  private async remote({ server, only }: McpTools): Promise<RunnableTool[]> {
    const config = this.config.mcp?.[server]
    if (!config) throw new CslugError('ai.unknown_mcp', `No MCP server "${server}" (config ai.mcp)`)
    const connection = this.connections.get(server) ?? new McpConnection(server, config)
    this.connections.set(server, connection)
    const listed = (await connection.request('tools/list')).tools as {
      name: string
      description?: string
      inputSchema: Record<string, unknown>
    }[]
    return listed
      .filter((t) => !only || only.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input: { toJSONSchema: () => t.inputSchema, safeParse: (data: unknown) => ({ success: true as const, data }) },
        handle: async (args: unknown) => {
          const result = await connection.request('tools/call', { name: t.name, arguments: args })
          const text = ((result.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('')
          if (result.isError) throw new Error(text)
          return result.structuredContent ?? text
        },
      }))
  }

  /** Close the MCP connections (stdio servers are stopped). */
  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.close()))
    this.connections.clear()
  }

  async run(agent: AgentSettings, options: RunOptions): Promise<unknown> {
    for await (const event of this.steps(agent, options, false)) if (event.type === 'result') return event.value
    throw new CslugError('ai.no_result', 'The agent finished without a result')
  }

  async *stream(agent: AgentSettings, options: RunOptions): AsyncIterable<string> {
    for await (const event of this.steps(agent, options, true)) if (event.type === 'text') yield event.text
  }

  private async *steps(agent: AgentSettings, { input, context = {} }: RunOptions, streaming: boolean) {
    const { instructions = '', maxSteps = 8 } = agent
    const tools: RunnableTool[] = []
    for (const t of agent.tools ?? []) tools.push(...(t instanceof McpTools ? await this.remote(t) : [resolve(t)]))
    const request: ModelRequest = {
      model: this.config.models?.[agent.model] ?? agent.model,
      system: typeof instructions === 'string' ? instructions : instructions.render(context),
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: modelSchema(t.input.toJSONSchema()),
      })),
      ...(agent.output ? { output: modelSchema(agent.output.toJSONSchema()) } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(agent.maxTokens ? { maxTokens: agent.maxTokens } : {}),
    }
    const provider = this.provider(agent.provider)
    const usage = { inputTokens: 0, outputTokens: 0 }
    for (let step = 1; step <= maxSteps; step++) {
      let response: ModelResponse | undefined
      if (streaming)
        for await (const event of provider.stream(request)) {
          if (event.type === 'text') yield event
          else response = event.response
        }
      else response = await provider.complete(request)
      if (!response) throw new CslugError('ai.provider', 'The stream ended without a response')
      usage.inputTokens += response.usage.inputTokens
      usage.outputTokens += response.usage.outputTokens
      request.messages.push({ role: 'assistant', content: response.content })
      const calls = response.content.filter((b) => b.type === 'tool_use')
      if (!calls.length) {
        this.log.info('ai.run', { agent: agent.constructor.name, model: request.model, steps: step, ...usage })
        yield {
          type: 'result' as const,
          value: agent.output ? this.parse(agent, textOf(response.content)) : textOf(response.content),
        }
        return
      }
      // every result of one turn goes back in one message
      request.messages.push({ role: 'user', content: await Promise.all(calls.map((call) => this.call(tools, call))) })
    }
    throw new CslugError('ai.max_steps', `${agent.constructor.name} did not finish in ${maxSteps} steps`)
  }

  private async call(tools: RunnableTool[], call: Extract<Block, { type: 'tool_use' }>): Promise<Block> {
    const result = (content: string, isError = false): Block => ({
      type: 'tool_result',
      toolUseId: call.id,
      content,
      isError,
    })
    const tool = tools.find((t) => t.name === call.name)
    if (!tool) return result(`Unknown tool ${call.name}`, true)
    const input = tool.input.safeParse(call.input)
    if (!input.success) return result(`Invalid input: ${JSON.stringify(input.error.issues)}`, true)
    try {
      const value = await tool.handle(input.data as never)
      return result(typeof value === 'string' ? value : JSON.stringify(value ?? null))
    } catch (error) {
      this.log.warn('ai.tool_failed', { tool: call.name, error })
      return result(error instanceof Error ? error.message : String(error), true)
    }
  }

  protected parse(agent: AgentSettings, text: string): unknown {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new AiOutputError(text, 'not JSON')
    }
    return this.validate(agent, json, text)
  }

  /** The value through the agent's `output` schema (coercions applied), or `AiOutputError`. */
  protected validate(agent: AgentSettings, value: unknown, text = ''): unknown {
    const parsed = agent.output?.safeParse(value)
    if (parsed && !parsed.success) throw new AiOutputError(text, parsed.error.issues)
    return parsed ? parsed.data : value
  }
}
