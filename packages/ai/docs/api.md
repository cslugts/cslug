# @cslug/ai: API

| | |
|---|---|
| `Agent` | Abstract `model`; settings `AgentSettings` (`instructions`, `output`, `tools`, `maxSteps`, `provider`, `effort`, `maxTokens`); `run(options)` → `AgentOutput<this>`; `result(options)` → `AiResult<AgentOutput<this>>`; `stream(options)` → `AiStream` |
| `RunOptions` | `{ input, context?, history? }`: `history` is a previous result's `messages` |
| `AiStream` | Async iterable of text; `result: Promise<AiResult>`, settled once the text is read |
| `Tool` | Abstract `name`, `description`, `input` (a `v` schema), `handle(input)` |
| `prompt(name)` / `Prompt` | `resources/prompts/<name>.md`; `render(vars)`, `ai.prompt_variables` when one is missing |
| `fillPrompt(template, vars, name?)` | `{{ path }}` (nested, objects as JSON), `{{ path \| default }}`; `PROMPT_VARIABLE` |
| `Instructions`, `renderInstructions(instructions, context)` | `string \| Prompt \| (context) => string \| Prompt` (or a promise of one); the system prompt for a run |
| `Ai` | Injectable runtime: `run(agent, options)`, `result(agent, options, meta?)` → `AiResult`, `stream(agent, options, meta?)`, `provider(name?)`, `extend(name, provider)`, `budget`, `recorder` |
| `AiResult` | `{ runId, value, raw, model, steps, usage, costUsd, messages }` |
| `Conversations` | `start(Agent, options)`, `find(Agent, id, options)`, `list(options)`; `store` (set with @cslug/database) |
| `Conversation` | `id`, `agent`, `title`, `metadata`, `owner`, `createdAt`; `send(input)`, `stream(input)`, `messages()`, `update(changes)`, `delete()` |
| `ConversationStore`, `ConversationRow`, `OwnerRef`, `StartOptions`, `FindOptions` | The store contract and shapes |
| `RunRecord`, `RunMeta` | A `cslug_ai_runs` row; `ai.result(agent, options, meta)`'s third argument (`conversationId`, `compact`) |
| `AI_MIGRATIONS` | The migrations folder (registered at boot with @cslug/database) |
| `AiProvider` | Config `ai`: `default`, `providers.<name>`, `models`, `mcp`, `budget`, `prices`, `runs`; binds `Conversations`; commands `ai:prompts`, `ai:record`, `ai:eval`, `mcp:serve` |
| `AiRecordCommand` | `cslug ai:record [path] [--all]`: `bun test` with `CSLUG_AI_RECORD` set, writing missing (all) fixtures |
| `AiEvalCommand` | `cslug ai:eval [folder] [--strict] [--json]`: fixtures through the real model; `jsonDiff(a, b)` |
| `Budget` | The daily budget: `spent()`, `check()`, `charge(model, usage)`; `BudgetConfig` `{ perDay: { usd }, alertAt? }` |
| `costOf(model, usage, prices?)`, `MODEL_PRICES`, `ModelPrice` | Estimated USD cost of a call (`undefined` without a price) |
| `AiBudgetError` | The day's budget is spent (`spentUsd`, `limitUsd`) |
| `AiBudgetAlert` | Event `ai.budget_alert` `{ day, spentUsd, limitUsd }`, once a day at `alertAt` |
| `AnthropicProvider`, `OpenAiCompatibleProvider` | The drivers; `Provider` is `{ complete(request), stream(request) }` |
| `ModelRequest`, `ModelResponse`, `Block`, `Message`, `StreamEvent`, `Usage` | The neutral request and response shapes (`Usage`: input, output, cache read and cache write tokens) |
| `modelSchema(jsonSchema)` | A JSON Schema as structured output accepts it |
| `sse(textStream)` | A `Responsable` streaming server-sent events |
| `AiOutputError` | The answer is not JSON or breaks the `output` schema (`text`, `issues`) |
| `AiRefusalError` | The model declined (`category`) |
| `mcp(options?)` | Decorator: expose a `Tool` over MCP (`public`, `guard`, `ability`) |
| `mcp(server).tools(names?)` | An MCP server's tools for an agent's `tools` |
| `McpConnection(name, config)` | A client: `request(method, params)`, `close()` |
| `handleMcp(message, tools, caller)` | One MCP message → its reply, over the `@mcp()` tools `caller` may use (core's `handleMcpMessage`); `asMcpTools(tools, caller)`, `MCP_VERSIONS`, `discoverTools(app)`, `mcpTools()` |
| `McpServeCommand` | `cslug mcp:serve` (stdio) |
| `AiFake`, `installAiFake(app)` | `fakes: ['ai']`: `respond`, `fixture(Agent, name)`, `assertRan`, `assertNotRan`, `ran`, `runs` |
| `AiFixture`, `FIXTURES_DIR` | A fixture file's shape (`history` when the run continued one); `tests/fixtures/ai` |
