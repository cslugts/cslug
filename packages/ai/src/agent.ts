import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Class, CslugError, currentApp, resolve } from '@cslug/core'
import type { Schema } from '@cslug/validation'
import type { AiResult } from './ai'
import { Ai } from './ai'
import type { AiStream } from './ai-stream'
import type { McpTools } from './mcp-client'
import type { Effort, Message } from './model'

/** A prompt file, `resources/prompts/<name>.md`, with `{{ variables }}` filled from the run's `context`. */
export class Prompt {
  constructor(readonly name: string) {}

  get path(): string {
    return join(currentApp().rootDir, 'resources/prompts', `${this.name}.md`)
  }

  render(vars: Record<string, unknown> = {}): string {
    if (!existsSync(this.path)) throw new CslugError('ai.no_prompt', `No prompt file resources/prompts/${this.name}.md`)
    const missing = new Set<string>()
    const text = readFileSync(this.path, 'utf8').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
      if (!(key in vars)) missing.add(key)
      return String(vars[key] ?? '')
    })
    if (missing.size)
      throw new CslugError('ai.prompt_variables', `Prompt ${this.name} needs ${[...missing].join(', ')} in context`)
    return text
  }
}

/** `instructions = prompt('proposals/extract-offer')` → `resources/prompts/proposals/extract-offer.md`. */
export const prompt = (name: string) => new Prompt(name)

/**
 * Something an agent can call: an `@inject()` class with a name, a description, an input schema and `handle(input)`.
 * The input is validated before `handle` runs; a validation failure or a thrown error goes back to the model as an
 * error result, so it can correct itself.
 */
export abstract class Tool {
  abstract name: string
  abstract description: string
  abstract input: Schema<unknown>
  abstract handle(input: never): unknown
}

/** What a run calls: a `Tool`, or an MCP server's tool (its input is checked by that server). */
export type RunnableTool = {
  name: string
  description: string
  input: Pick<Schema<unknown>, 'toJSONSchema' | 'safeParse'>
  handle(input: never): unknown
}
export type ToolClass = Class<Tool>

export type RunOptions = {
  input: string
  context?: Record<string, unknown>
  /**
   * The conversation so far: a previous result's `messages`, unchanged. The run continues it (append-only, so the
   * provider's prompt cache keeps the earlier turns).
   */
  history?: Message[]
}

/**
 * What an agent may declare besides `model`. These are deliberately not declared on `Agent` (as for jobs), so apps
 * compiled with `noImplicitOverride` write `instructions = …` without `override`.
 */
export type AgentSettings = {
  /** A model ID (`claude-opus-5-5`), or a role from config `ai.models` (`fast`, `smart`). */
  model: string
  instructions?: string | Prompt
  /** Structured output: the answer is parsed and validated (`AiOutputError` otherwise). */
  output?: Schema<unknown>
  /** Tool classes, and MCP servers' tools: `tools = [FindOperatorsTool, ...mcp('maps').tools(['route_duration'])]`. */
  tools?: (ToolClass | McpTools)[]
  /** Model calls before giving up (each tool round is one); default 8. */
  maxSteps?: number
  /** A provider from config `ai.providers` (default: `ai.default`). */
  provider?: string
  effort?: Effort
  maxTokens?: number
}

/** What `run()` returns: the `output` schema's type, or the text. */
export type AgentOutput<A> = A extends { output: Schema<infer O> } ? O : string

/**
 * An AI task as a class: a model, instructions, optional tools and an optional `output` schema
 * ({@link AgentSettings}). `run()` returns the result; `stream()` yields the text as it arrives. Pass a previous
 * result's `messages` as `history` to continue a conversation.
 */
export abstract class Agent {
  abstract model: string

  run(options: RunOptions): Promise<AgentOutput<this>> {
    return resolve(Ai).run(this, options) as Promise<AgentOutput<this>>
  }

  /** The run in detail: the value, the raw answer, `messages` (the conversation to pass as `history` next turn), usage, cost. */
  result(options: RunOptions): Promise<AiResult<AgentOutput<this>>> {
    return resolve(Ai).result(this, options) as Promise<AiResult<AgentOutput<this>>>
  }

  /** The text as it arrives; `.result` gives the finished run once it has been read. */
  stream(options: RunOptions): AiStream<AgentOutput<this>> {
    return resolve(Ai).stream(this, options) as AiStream<AgentOutput<this>>
  }
}
