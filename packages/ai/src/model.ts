import { CslugError } from '@cslug/core'

/** A content block, close to the Anthropic Messages API. `raw` carries a provider's own blocks back unchanged. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { type: 'raw'; value: unknown }
export type Message = { role: 'user' | 'assistant'; content: Block[] }
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelRequest = {
  model: string
  system: string
  messages: Message[]
  tools: ToolSpec[]
  /** JSON Schema the final answer must follow (structured output). */
  output?: Record<string, unknown>
  maxTokens?: number
  effort?: Effort
}
/** Tokens a model call used; cache reads and writes are counted apart from `inputTokens` (Anthropic). */
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
export type ModelResponse = { content: Block[]; stopReason: string; usage: Usage }
/** While streaming: text as it arrives, then the whole response. */
export type StreamEvent = { type: 'text'; text: string } | { type: 'done'; response: ModelResponse }

/** A model API. Built from `config/ai.ts` → `providers.<name>`. */
export interface Provider {
  complete(request: ModelRequest): Promise<ModelResponse>
  stream(request: ModelRequest): AsyncIterable<StreamEvent>
}

/** The provider declined (a safety refusal). */
export class AiRefusalError extends CslugError {
  constructor(readonly category?: string) {
    super('ai.refusal', `The model declined the request${category ? ` (${category})` : ''}`)
  }
}

/** POST JSON; a non-2xx answer is an `ai.provider` error with the provider's message. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (!res.ok)
    throw new CslugError(
      'ai.provider',
      `${new URL(url).host} answered ${res.status}: ${(await res.text()).slice(0, 500)}`,
    )
  return res
}

/** Server-sent events as `{ event, data }`, parsed from a fetch body. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<{ event?: string; data: string }> {
  const decoder = new TextDecoder()
  const reader = body.getReader() // not `for await`: some DOM typings lack ReadableStream's async iterator
  let buffer = ''
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    buffer += decoder.decode(read.value, { stream: true })
    let end = buffer.indexOf('\n\n')
    while (end >= 0) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const event = /^event: ?(.*)$/m.exec(frame)?.[1]
      const data = [...frame.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n')
      if (data) yield { event, data }
      end = buffer.indexOf('\n\n')
    }
  }
}

const UNSUPPORTED = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  '$schema',
]

/**
 * A `v` schema's JSON Schema as structured output accepts it: numeric, length and array constraints removed (the
 * `v` schema still checks them on the answer), `additionalProperties: false` on every object.
 */
export function modelSchema(schema: object): Record<string, unknown> {
  const clean = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(clean) : x && typeof x === 'object' ? modelSchema(x) : x
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED.includes(k)) continue
    // under `properties` the keys are field names (a field may be called `pattern`), not keywords
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([name, field]) => [name, clean(field)]))
        : clean(v)
  }
  if (out.type === 'object') out.additionalProperties = false
  return out
}
