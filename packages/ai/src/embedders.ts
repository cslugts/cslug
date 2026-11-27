import { CslugError } from '@cslug/core'
import type { Budget } from './budget'
import { postJson } from './model'

/** `config/ai.ts` → `embeddings`: the model `@cslug/search` embeds documents and queries with. */
export type EmbeddingsConfig =
  | {
      driver: 'openai-compatible'
      /** The API root (`https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama). */
      baseUrl: string
      apiKey?: string
      model: string
      /** Shorter vectors, for models that support it. */
      dimensions?: number
    }
  | {
      driver: 'voyage'
      /** Default: `VOYAGE_API_KEY`. */
      apiKey?: string
      /** `voyage-3.5`, `voyage-3.5-lite`, `voyage-multilingual-2`… */
      model: string
      dimensions?: number
      baseUrl?: string
    }

type Json = Record<string, unknown>

/** What `@cslug/search`'s `Embedder` asks for (structural: this package does not import search). */
export interface TextEmbedder {
  readonly model: string
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>
}

/** The vectors of a `/embeddings` response, in input order. */
function vectorsOf(json: Json, count: number): number[][] {
  const data = ((json.data ?? []) as { embedding: number[]; index: number }[]).slice().sort((a, b) => a.index - b.index)
  if (data.length !== count)
    throw new CslugError('ai.embeddings', `The embeddings API returned ${data.length} vectors for ${count} texts`)
  return data.map((d) => d.embedding)
}

/** Embeddings over `fetch`, charged to the daily budget (`ai.budget`) as input tokens of `model`. */
abstract class HttpEmbedder implements TextEmbedder {
  /** Identifies the vectors: the model, and the dimensions when set (`voyage-3.5@512`). */
  abstract readonly model: string
  /** The model's name as priced in the budget (`ai.prices`). */
  protected abstract readonly priced: string
  constructor(protected readonly budget?: () => Budget | undefined) {}

  protected abstract request(texts: string[], purpose: 'document' | 'query'): [string, Record<string, string>, Json]
  protected abstract tokens(json: Json): number

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    if (!texts.length) return []
    const budget = this.budget?.()
    await budget?.check()
    const json = (await (await postJson(...this.request(texts, purpose))).json()) as Json
    await budget?.charge(this.priced, { inputTokens: this.tokens(json), outputTokens: 0 })
    return vectorsOf(json, texts.length)
  }
}

/** Any OpenAI-compatible `/embeddings` endpoint (OpenAI, Ollama, vLLM, LM Studio…). */
export class OpenAiCompatibleEmbedder extends HttpEmbedder {
  readonly model: string
  protected readonly priced: string
  constructor(
    private readonly config: Extract<EmbeddingsConfig, { driver: 'openai-compatible' }>,
    budget?: () => Budget | undefined,
  ) {
    super(budget)
    this.model = config.dimensions ? `${config.model}@${config.dimensions}` : config.model
    this.priced = config.model
  }

  protected request(texts: string[]): [string, Record<string, string>, Json] {
    const headers: Record<string, string> = this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}
    return [
      `${this.config.baseUrl.replace(/\/$/, '')}/embeddings`,
      headers,
      {
        model: this.config.model,
        input: texts,
        ...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
      },
    ]
  }

  protected tokens(json: Json): number {
    const usage = (json.usage ?? {}) as Json
    return Number(usage.prompt_tokens ?? usage.total_tokens ?? 0)
  }
}

/** Voyage AI embeddings (the provider Anthropic recommends): queries and documents are embedded differently. */
export class VoyageEmbedder extends HttpEmbedder {
  readonly model: string
  protected readonly priced: string
  constructor(
    private readonly config: Extract<EmbeddingsConfig, { driver: 'voyage' }>,
    budget?: () => Budget | undefined,
  ) {
    super(budget)
    this.model = config.dimensions ? `${config.model}@${config.dimensions}` : config.model
    this.priced = config.model
  }

  protected request(texts: string[], purpose: 'document' | 'query'): [string, Record<string, string>, Json] {
    const key = this.config.apiKey ?? process.env.VOYAGE_API_KEY
    if (!key) throw new CslugError('ai.no_key', 'Set VOYAGE_API_KEY (or embeddings.apiKey in config/ai.ts)')
    return [
      `${(this.config.baseUrl ?? 'https://api.voyageai.com/v1').replace(/\/$/, '')}/embeddings`,
      { authorization: `Bearer ${key}` },
      {
        model: this.config.model,
        input: texts,
        input_type: purpose,
        ...(this.config.dimensions ? { output_dimension: this.config.dimensions } : {}),
      },
    ]
  }

  protected tokens(json: Json): number {
    return Number(((json.usage ?? {}) as Json).total_tokens ?? 0)
  }
}

/** The embedder for `config/ai.ts` → `embeddings`. */
export function embedderFor(config: EmbeddingsConfig, budget?: () => Budget | undefined): TextEmbedder {
  if (config.driver === 'voyage') return new VoyageEmbedder(config, budget)
  if (config.driver === 'openai-compatible') return new OpenAiCompatibleEmbedder(config, budget)
  throw new CslugError('ai.unknown_driver', `Unknown embeddings driver "${(config as { driver: string }).driver}"`)
}
