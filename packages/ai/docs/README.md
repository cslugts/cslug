# @cslug/ai

List `AiProvider` in `bootstrap/providers.ts` (`cslug add ai` does it and writes `config/ai.ts`). The guide is
[guide 18](../../../guides/18-ai.md).

## Agents

An agent is an `@inject()` class with a `model` (a model ID, or a role from `ai.models`) and, optionally,
`instructions` (a string, `prompt('name')`, or a function of the context), `output` (a `v` schema), `tools`, `maxSteps` (8), `provider`,
`effort` and `maxTokens`. These settings are not declared on `Agent`, as for jobs, so apps compiled with
`noImplicitOverride` don't write `override`.

`run({ input, context })`:

1. renders the instructions: a function is called with `context` (and awaited); a prompt file is filled from it,
2. calls the provider with the tools and, with `output`, the schema as structured output (the JSON Schema without
   the constraints the API rejects: numeric and length limits, patterns, array sizes),
3. while the model calls tools: validates each input with the tool's schema, runs the calls of the turn together and
   sends every result back in one message (an invalid input or a thrown error as an error result),
4. parses and validates the final answer with the full schema → typed result, or `AiOutputError`.

`stream({ input, context })` yields the text as it arrives (tools run between turns). `sse(stream)` makes it a
`text/event-stream` response, keeping the request's context. The stream's `result` promise settles with the finished
run once the text has been read (and rejects with the run's error).

**Conversations.** `history` takes a previous result's `messages` and continues them: the request is the history,
then the new input. `result()` (on the agent or on `Ai`) and `stream().result` return `messages`: the history plus
this run's input, tool rounds and answer, to pass as `history` next turn. Provider blocks (thinking, fallbacks) are
kept, so send the messages back unchanged; they are JSON. The history passed in is not modified. With the Anthropic
driver and `promptCaching` on, a request with more than one message also sets automatic caching (top-level
`cache_control`), after the system prompt's breakpoint, so each turn and tool round reads the earlier ones from the
cache.

## Stored conversations and run records (with @cslug/database)

`AiProvider` registers the `cslug_ai` migration when `Database` is bound:

| Table | Holds |
|---|---|
| `cslug_ai_conversations` | `id` (UUIDv7), `agent` (class name), `owner_type` + `owner_id`, `title`, `metadata` (jsonb), `message_count`, timestamps |
| `cslug_ai_messages` | `conversation_id` + `position` (key), `role`, `content` (the blocks, jsonb), `run_id` |
| `cslug_ai_runs` | one row per run: agent, model, `conversation_id`, `user_id` (the signed-in user), status (`completed` / `failed`), steps, token counts, `cost_usd` (estimate), error, `started_at` / `finished_at` |

`Conversations` (injectable):

- `start(Agent, { owner?, ownerType?, title?, metadata? })`: the owner is the signed-in user (the ambient context's
  `userId`, set by @cslug/auth) unless given; `owner: null` for none; `ownerType` defaults to `user`.
- `find(Agent, id, { owner?, ownerType? })`: the conversation if it was started with that agent and its owner is the
  signed-in user (or the owner given); an unowned one is open to anyone. Anything else, a malformed id included,
  is `NotFoundError`.
- `list({ owner?, ownerType?, agent?, limit = 50 })`: rows, most recent first (`updatedAt`); empty without an owner.

`Conversation`: `id`, `agent`, `title`, `metadata`, `owner`, `createdAt`; `send(input, { context })` →
`AiResult` (the stored history, then the input; the new messages are appended with the run's id); `stream(input)` →
`AiStream` (stored once read); `messages()`; `update({ title, metadata })`; `delete()` (messages too; run records
keep their row, unlinked). A turn is stored only if no other was stored since it read the history, else
`ConflictError` (`ai.conversation_changed`). Turns in a conversation ask for server-side compaction
(`compact_20260112`, Anthropic models that support it); `compact = false` on the agent turns it off, `compact = true`
turns it on for plain runs. Timestamps come from `Clock`.

`Ai` records every run (`ai.result`, `run`, `stream`; in a conversation or not) through `ai.recorder`;
`ai.runs: false` turns it off, and a failure to record is logged (`ai.run_not_recorded`), never thrown. Without
@cslug/database nothing is recorded, and `Conversations` throws `ai.no_database`.

## Prompts

`prompt('trips/brief')` reads `resources/prompts/trips/brief.md` on every run and fills it with `fillPrompt`:

| In the file | Gives |
|---|---|
| `{{ name }}` | `context.name`: a string as is, a number or boolean as text, a `Date` as ISO, an object or a list as indented JSON (bigint as text) |
| `{{ trip.circuit.name }}` | A nested value (each step must be an object) |
| `{{ language \| English }}` | The value, or `English` when it is missing or null (`{{ note \| }}`: empty) |

A missing value without a default throws `ai.prompt_variables` listing every one; a present `null` without a
default renders empty. `cslug ai:prompts` lists each file and its variables, with `?` after those that have a
default. `PROMPT_VARIABLE` is the pattern (path, default); `renderInstructions(instructions, context)` gives the
system prompt for any `Instructions`.

## Providers

| Driver | Config | |
|---|---|---|
| `anthropic` | `apiKey` (default `ANTHROPIC_API_KEY`), `baseUrl`, `promptCaching` (true), `fallbacks` (true) | The Messages API (`anthropic-version: 2026-10-21`) with `fetch`: the system prompt cached with `cache_control`, structured output through `output_config.format`, `effort` in `output_config`, `max_tokens` 16000 (64000 when streaming). On the models that have server-side refusal fallbacks (Claude Fable 5.2 / 5.1, Opus 5.5 / 5, Sonnet 5.5) requests carry `fallbacks: "default"`. Thinking and other blocks are sent back unchanged in a tool loop. A refusal is `AiRefusalError` (`category`) |
| `openai-compatible` | `baseUrl`, `apiKey` | Chat completions (Ollama, vLLM, LM Studio…): function tools, `response_format` JSON Schema, streaming |

Without `config/ai.ts`, the default provider is `anthropic`. `ai.extend(name, provider)` adds one (any object with
`complete` and `stream`).

`ai.result(agent, { input, context })` is `run()` in detail: `{ value, raw, model, steps, usage, costUsd }` (`raw` is
the answer before validation: the parsed JSON, or the text).

## Daily budget

```ts
budget: { perDay: { usd: 10 }, alertAt: 0.8 },     // config/ai.ts
prices: { 'llama3.3': { input: 0, output: 0 } },    // USD per million tokens, for models the built-in table lacks
```

Each model call is charged after it answers, at the model's price (`MODEL_PRICES`: Anthropic's first-party prices;
cache reads at 0.1× and cache writes at 1.25× the input price). Before each call, a spend at or above the limit is
`AiBudgetError`: nothing is called until the next day in the app's time zone. When the spend crosses `alertAt` (0.8)
of the limit, `AiBudgetAlert` (`ai.budget_alert`: `{ day, spentUsd, limitUsd }`) is emitted once and logged. The spend
is kept in the app's `Cache` (`ai:spend:<day>`), so with @cslug/redis every process shares it; with the in-memory
cache each process counts its own. A model without a price costs nothing and is logged once (`ai.budget_unpriced`).
The figures are estimates from the token counts, not the provider's bill.

## Tests

`testApp({ fakes: ['ai'] })` → `t.ai`: no provider is called. `respond(Agent, output | (run) => output)` gives an
agent its answer (checked against its `output` schema); `assertRan(Agent, where?)`, `assertNotRan(Agent)`,
`ran(Agent)`, `runs`.

**Recorded fixtures.** `t.ai.fixture(Agent, 'proposals/isalo')` answers with `tests/fixtures/ai/proposals/isalo.json`
(validated like `respond`). A missing file is an error that names the command to run:

- `cslug ai:record [path]` runs `bun test [path]` with `CSLUG_AI_RECORD=missing`: a `fixture()` whose file is
  missing calls the real provider (config `ai`) and writes `{ agent, input, context, output, model, recordedAt }`,
  `output` being the raw answer. `--all` re-records every fixture the tests reach. Commit the files.
- `cslug ai:eval [folder]` runs every fixture under `tests/fixtures/ai/[folder]` through the real model, with the
  agent class found by name in `app/agents/`: `same`, `diff` (the changed paths), `schema` (an `AiOutputError`) or
  `error`, plus the estimated cost. Schema failures and errors exit 1; diffs only with `--strict`. `--json` prints
  the rows.

Both call the provider and cost money (and count against the daily budget).

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
