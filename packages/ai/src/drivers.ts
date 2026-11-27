import { CslugError } from '@cslug/core'
import {
  AiRefusalError,
  type Block,
  type ModelRequest,
  type ModelResponse,
  type Provider,
  postJson,
  type StreamEvent,
  sseEvents,
} from './model'

type Json = Record<string, unknown>

export type AnthropicConfig = {
  driver: 'anthropic'
  /** Default: `ANTHROPIC_API_KEY`. */
  apiKey?: string
  baseUrl?: string
  /**
   * Prompt caching, on by default: a breakpoint on the system prompt, and automatic caching (top-level
   * `cache_control`) once there is more than one message, so each turn or tool round reads the earlier ones.
   */
  promptCaching?: boolean
  /** Server-side refusal fallbacks (`fallbacks: "default"`) on the models that have them; on by default. */
  fallbacks?: boolean
}

const API_VERSION = '2026-10-21'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const WITH_FALLBACKS = ['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']

const toAnthropic = (b: Block): unknown =>
  b.type === 'raw'
    ? b.value
    : b.type === 'tool_result'
      ? { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, ...(b.isError ? { is_error: true } : {}) }
      : b
const fromAnthropic = (b: Json): Block =>
  b.type === 'text'
    ? { type: 'text', text: String(b.text) }
    : b.type === 'tool_use'
      ? { type: 'tool_use', id: String(b.id), name: String(b.name), input: b.input }
      : { type: 'raw', value: b } // thinking, fallback…: sent back unchanged

/** The Claude Messages API over `fetch` (no SDK: cslug has no third-party runtime dependencies). */
export class AnthropicProvider implements Provider {
  constructor(private readonly config: AnthropicConfig) {}

  private request(r: ModelRequest, stream: boolean): [string, Record<string, string>, Json] {
    const key = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!key) throw new CslugError('ai.no_key', 'Set ANTHROPIC_API_KEY (or providers.<name>.apiKey in config/ai.ts)')
    const fallbacks = this.config.fallbacks !== false && WITH_FALLBACKS.includes(r.model)
    const format = r.output ? { format: { type: 'json_schema', schema: r.output } } : {}
    const caching = this.config.promptCaching !== false
    const body: Json = {
      model: r.model,
      max_tokens: r.maxTokens ?? (stream ? 64_000 : 16_000),
      messages: r.messages.map((m) => ({ role: m.role, content: m.content.map(toAnthropic) })),
      ...(r.system
        ? {
            system: [
              {
                type: 'text',
                text: r.system,
                ...(caching ? { cache_control: { type: 'ephemeral' } } : {}),
              },
            ],
          }
        : {}),
      ...(r.tools.length
        ? { tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
        : {}),
      ...(r.output || r.effort ? { output_config: { ...format, ...(r.effort ? { effort: r.effort } : {}) } } : {}),
      ...(caching && r.messages.length > 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      ...(fallbacks ? { fallbacks: 'default' } : {}),
      ...(stream ? { stream: true } : {}),
    }
    const headers = {
      'x-api-key': key,
      'anthropic-version': API_VERSION,
      ...(fallbacks ? { 'anthropic-beta': FALLBACK_BETA } : {}),
    }
    return [`${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, headers, body]
  }

  private response(message: Json): ModelResponse {
    if (message.stop_reason === 'refusal')
      throw new AiRefusalError((message.stop_details as Json | null)?.category as string | undefined)
    const usage = (message.usage ?? {}) as Json
    return {
      content: ((message.content ?? []) as Json[]).map(fromAnthropic),
      stopReason: String(message.stop_reason),
      usage: {
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
        cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0),
      },
    }
  }

  async complete(r: ModelRequest): Promise<ModelResponse> {
    return this.response((await (await postJson(...this.request(r, false))).json()) as Json)
  }

  /** Text deltas as they arrive; blocks are rebuilt from their deltas (tool inputs from `partial_json`). */
  async *stream(r: ModelRequest): AsyncIterable<StreamEvent> {
    const res = await postJson(...this.request(r, true))
    const message: Json = { content: [] }
    const blocks = message.content as Json[]
    const partial: string[] = []
    for await (const { data } of sseEvents(res.body as ReadableStream<Uint8Array>)) {
      const e = JSON.parse(data) as Json
      if (e.type === 'message_start') Object.assign(message, e.message, { content: blocks })
      else if (e.type === 'content_block_start') blocks[Number(e.index)] = { ...(e.content_block as Json) }
      else if (e.type === 'content_block_delta') {
        const block = blocks[Number(e.index)] as Json
        const delta = e.delta as Json
        if (delta.type === 'input_json_delta')
          partial[Number(e.index)] = (partial[Number(e.index)] ?? '') + delta.partial_json
        else
          for (const [k, v] of Object.entries(delta))
            if (k !== 'type') block[k] = typeof v === 'string' && typeof block[k] === 'string' ? block[k] + v : v
        if (delta.type === 'text_delta') yield { type: 'text', text: String(delta.text) }
      } else if (e.type === 'content_block_stop' && partial[Number(e.index)] !== undefined)
        (blocks[Number(e.index)] as Json).input = JSON.parse(partial[Number(e.index)] || '{}')
      else if (e.type === 'message_delta') {
        Object.assign(message, e.delta)
        message.usage = { ...(message.usage as Json), ...(e.usage as Json) }
      } else if (e.type === 'error') throw new CslugError('ai.provider', JSON.stringify(e.error))
    }
    yield { type: 'done', response: this.response(message) }
  }
}

export type OpenAiCompatibleConfig = { driver: 'openai-compatible'; baseUrl: string; apiKey?: string }

/** Any OpenAI-compatible chat completions endpoint (Ollama, vLLM, LM Studio…). */
export class OpenAiCompatibleProvider implements Provider {
  constructor(private readonly config: OpenAiCompatibleConfig) {}

  private request(r: ModelRequest, stream: boolean): [string, Record<string, string>, Json] {
    const messages: Json[] = r.system ? [{ role: 'system', content: r.system }] : []
    for (const m of r.messages) {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }]
          : [],
      )
      for (const b of m.content)
        if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content })
      if (text || calls.length)
        messages.push({ role: m.role, content: text, ...(calls.length ? { tool_calls: calls } : {}) })
    }
    const body: Json = {
      model: r.model,
      messages,
      ...(r.maxTokens ? { max_tokens: r.maxTokens } : {}),
      ...(r.tools.length
        ? {
            tools: r.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(r.output
        ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: r.output, strict: true } } }
        : {}),
      ...(stream ? { stream: true } : {}),
    }
    const headers: Record<string, string> = this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}
    return [`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, headers, body]
  }

  private response(
    text: string,
    calls: { id: string; name: string; arguments: string }[],
    finish: unknown,
    usage?: Json,
  ) {
    const content: Block[] = text ? [{ type: 'text', text }] : []
    for (const c of calls)
      content.push({ type: 'tool_use', id: c.id, name: c.name, input: JSON.parse(c.arguments || '{}') })
    return {
      content,
      stopReason: calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn',
      usage: { inputTokens: Number(usage?.prompt_tokens ?? 0), outputTokens: Number(usage?.completion_tokens ?? 0) },
    }
  }

  async complete(r: ModelRequest): Promise<ModelResponse> {
    const json = (await (await postJson(...this.request(r, false))).json()) as Json
    const choice = ((json.choices ?? []) as Json[])[0] ?? {}
    const message = (choice.message ?? {}) as Json
    const calls = ((message.tool_calls ?? []) as Json[]).map((c) => {
      const fn = c.function as Json
      return { id: String(c.id), name: String(fn.name), arguments: String(fn.arguments ?? '') }
    })
    return this.response(String(message.content ?? ''), calls, choice.finish_reason, json.usage as Json)
  }

  async *stream(r: ModelRequest): AsyncIterable<StreamEvent> {
    const res = await postJson(...this.request(r, true))
    let text = ''
    let finish: unknown
    const calls: { id: string; name: string; arguments: string }[] = []
    for await (const { data } of sseEvents(res.body as ReadableStream<Uint8Array>)) {
      if (data === '[DONE]') break
      const choice = (((JSON.parse(data) as Json).choices ?? []) as Json[])[0] ?? {}
      const delta = (choice.delta ?? {}) as Json
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        yield { type: 'text', text: delta.content }
      }
      for (const c of (delta.tool_calls ?? []) as Json[]) {
        const fn = (c.function ?? {}) as Json
        const call = calls[Number(c.index)] ?? { id: '', name: '', arguments: '' }
        calls[Number(c.index)] = call
        call.id ||= String(c.id ?? '')
        call.name ||= String(fn.name ?? '')
        call.arguments += String(fn.arguments ?? '')
      }
      finish = choice.finish_reason ?? finish
    }
    yield { type: 'done', response: this.response(text, calls, finish) }
  }
}
