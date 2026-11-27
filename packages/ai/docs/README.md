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

## MCP

**Serving.** `@mcp(options)` on a `Tool` class in `app/tools/` (imported at boot) exposes it:

- `POST /mcp` (when @cslug/http is installed and a tool is exposed): streamable HTTP with JSON responses, `202` for
  notifications, `404` for an unknown method, `405` for GET, `403` when `Origin` is not `app.url`'s. It runs the api
  group's middleware, so `ctx.auth` (from @cslug/auth) is the caller. Options: none → any authenticated caller;
  `public: true` → anyone; `guard: 'token'` → that guard; `ability: 'mcp:x'` → a token with that ability (session
  users pass). A tool the caller may not use is not listed and is "unknown" when called.
- `cslug mcp:serve`: stdio (newline-delimited JSON-RPC on stdout, logs on stderr); every exposed tool.

Protocol: `server/discover` and per-request versions (2026-07-28), and `initialize` for 2025-11-25, 2025-06-18 and
2025-03-26 (the client's version if supported, else 2025-11-25). `tools/list`, `tools/call` (input validated; a
plain-object result is also `structuredContent`; an error is `isError: true`), `ping`. An unsupported
`_meta["io.modelcontextprotocol/protocolVersion"]` is error `-32022`.

**Using a server.** `config/ai.ts` → `mcp.<name>`: `{ url, headers? }` or `{ command, env? }` (stdio, started on first
use, stopped at shutdown). In an agent: `tools = [...mcp('maps').tools(['route_duration'])]` (all tools without a
list). The client tries `server/discover` (2026-07-28), else `initialize` (2025-11-25), keeps `Mcp-Session-Id` for
older HTTP servers, reads JSON or SSE responses. A tool error comes back to the model as an error result.

## Not yet

`ai:record` / `ai:eval` and the daily budget come next.
