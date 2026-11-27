import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Class, CslugError, currentApp, resolve } from '@cslug/core'
import type { Schema } from '@cslug/validation'
import type { AiResult } from './ai'
import { Ai } from './ai'
import type { AiStream } from './ai-stream'
import type { McpTools } from './mcp-client'
import type { Effort, Message } from './model'

/** `{{ path }}` or `{{ path | default }}`: a dotted path into the context, and an optional fallback text. */
export const PROMPT_VARIABLE = /\{\{\s*([\w]+(?:\.[\w]+)*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g

const lookup = (vars: Record<string, unknown>, path: string): { found: boolean; value: unknown } => {
  let value: unknown = vars
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(key in value)) return { found: false, value: undefined }
    value = (value as Record<string, unknown>)[key]
  }
  return { found: true, value }
}

const asText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value !== null && typeof value === 'object' && !(value instanceof Date)
      ? JSON.stringify(value, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)
      : String(value instanceof Date ? value.toISOString() : value)

/**
 * Fill a prompt template: `{{ trip.circuit }}` reads a nested value, an object or a list is written as JSON,
 * `{{ language | English }}` falls back when the value is missing or null. A missing value without a default is
 * an `ai.prompt_variables` error naming every one.
 */
export function fillPrompt(template: string, vars: Record<string, unknown>, name = 'prompt'): string {
  const missing = new Set<string>()
  const text = template.replace(PROMPT_VARIABLE, (_m, path: string, fallback: string | undefined) => {
    const { found, value } = lookup(vars, path)
    if (found && value !== null && value !== undefined) return asText(value)
    if (fallback !== undefined) return fallback
    if (!found) missing.add(path)
    return ''
  })
  if (missing.size)
    throw new CslugError('ai.prompt_variables', `Prompt ${name} needs ${[...missing].join(', ')} in context`)
  return text
}

/** A prompt file, `resources/prompts/<name>.md`, with `{{ variables }}` filled from the run's `context`. */
export class Prompt {
  constructor(readonly name: string) {}

  get path(): string {
    return join(currentApp().rootDir, 'resources/prompts', `${this.name}.md`)
  }

  render(vars: Record<string, unknown> = {}): string {
    if (!existsSync(this.path)) throw new CslugError('ai.no_prompt', `No prompt file resources/prompts/${this.name}.md`)
    return fillPrompt(readFileSync(this.path, 'utf8'), vars, this.name)
  }
}

/** What an agent's `instructions` may be. */
export type Instructions =
  | string
  | Prompt
  | ((context: Record<string, unknown>) => string | Prompt | Promise<string | Prompt>)

/** The system prompt for a run: a function is called with the context, a `Prompt` is filled from it. */
export async function renderInstructions(
  instructions: Instructions | undefined,
  context: Record<string, unknown>,
): Promise<string> {
  const value = typeof instructions === 'function' ? await instructions(context) : (instructions ?? '')
  return typeof value === 'string' ? value : value.render(context)
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
  /**
   * A string, `prompt('name')` (a file with `{{ variables }}`), or a function of the run's `context` returning
   * either (it may be async), for instructions built in code.
   */
  instructions?: Instructions
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
  /**
   * Let the provider summarise a long history server-side (Anthropic compaction, at about 150K input tokens, on the
   * models that support it). On by default in a `Conversation`; `false` turns it off there.
   */
  compact?: boolean
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
