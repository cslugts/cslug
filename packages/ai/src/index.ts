/**
 * @cslug/ai: agents and tools as `@inject()` classes, structured output validated by `v` schemas, prompts as
 * Markdown files, streaming to the browser, Anthropic and OpenAI-compatible providers over `fetch`, a test fake.
 */
export {
  Agent,
  type AgentOutput,
  type AgentSettings,
  Prompt,
  prompt,
  type RunOptions,
  Tool,
  type ToolClass,
} from './agent'
export { Ai, type AiConfig, AiOutputError } from './ai'
export { AiPromptsCommand, AiProvider } from './ai-provider'
export {
  type AnthropicConfig,
  AnthropicProvider,
  type OpenAiCompatibleConfig,
  OpenAiCompatibleProvider,
} from './drivers'
export { AiFake, type AiRun, installAiFake } from './fake'
export {
  AiRefusalError,
  type Block,
  type Effort,
  type Message,
  type ModelRequest,
  type ModelResponse,
  modelSchema,
  type Provider,
  type StreamEvent,
  type ToolSpec,
  type Usage,
} from './model'
export { sse } from './sse'
