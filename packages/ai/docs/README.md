# @cslug/ai

List `AiProvider` in `bootstrap/providers.ts` (`cslug add ai` does it and writes `config/ai.ts`). The guide is
[guide 18](../../../guides/18-ai.md).

## Agents

An agent is an `@inject()` class with a `model` (a model ID, or a role from `ai.models`) and, optionally,
`instructions` (a string or `prompt('name')`), `output` (a `v` schema), `tools`, `maxSteps` (8), `provider`,
`effort` and `maxTokens`. These settings are not declared on `Agent`, as for jobs, so apps compiled with
`noImplicitOverride` don't write `override`.

`run({ input, context })`:

1. renders the instructions (`{{ variables }}` from `context`),
2. calls the provider with the tools and, with `output`, the schema as structured output (the JSON Schema without
   the constraints the API rejects: numeric and length limits, patterns, array sizes),
3. while the model calls tools: validates each input with the tool's schema, runs the calls of the turn together and
   sends every result back in one message (an invalid input or a thrown error as an error result),
4. parses and validates the final answer with the full schema → typed result, or `AiOutputError`.

`stream({ input, context })` yields the text as it arrives (tools run between turns). `sse(stream)` makes it a
`text/event-stream` response, keeping the request's context.

## Providers

| Driver | Config | |
|---|---|---|
| `anthropic` | `apiKey` (default `ANTHROPIC_API_KEY`), `baseUrl`, `promptCaching` (true), `fallbacks` (true) | The Messages API (`anthropic-version: 2026-10-21`) with `fetch`: the system prompt cached with `cache_control`, structured output through `output_config.format`, `effort` in `output_config`, `max_tokens` 16000 (64000 when streaming). On the models that have server-side refusal fallbacks (Claude Fable 5.2 / 5.1, Opus 5.5 / 5, Sonnet 5.5) requests carry `fallbacks: "default"`. Thinking and other blocks are sent back unchanged in a tool loop. A refusal is `AiRefusalError` (`category`) |
| `openai-compatible` | `baseUrl`, `apiKey` | Chat completions (Ollama, vLLM, LM Studio…): function tools, `response_format` JSON Schema, streaming |

Without `config/ai.ts`, the default provider is `anthropic`. `ai.extend(name, provider)` adds one (any object with
`complete` and `stream`).

## Tests

`testApp({ fakes: ['ai'] })` → `t.ai`: no provider is called. `respond(Agent, output | (run) => output)` gives an
agent its answer (checked against its `output` schema); `assertRan(Agent, where?)`, `assertNotRan(Agent)`,
`ran(Agent)`, `runs`.

## Not yet

MCP (server and client), `ai:record` / `ai:eval` and the daily budget come in the next part of this package.
