# @cslug/ai: API

| | |
|---|---|
| `Agent` | Abstract `model`; settings `AgentSettings` (`instructions`, `output`, `tools`, `maxSteps`, `provider`, `effort`, `maxTokens`); `run(options)` → `AgentOutput<this>`; `stream(options)` → text |
| `Tool` | Abstract `name`, `description`, `input` (a `v` schema), `handle(input)` |
| `prompt(name)` / `Prompt` | `resources/prompts/<name>.md`; `render(vars)`, `ai.prompt_variables` when one is missing |
| `Ai` | Injectable runtime: `run(agent, options)`, `stream(agent, options)`, `provider(name?)`, `extend(name, provider)` |
| `AiProvider` | Config `ai`: `default`, `providers.<name>`, `models`; command `ai:prompts` |
| `AnthropicProvider`, `OpenAiCompatibleProvider` | The drivers; `Provider` is `{ complete(request), stream(request) }` |
| `ModelRequest`, `ModelResponse`, `Block`, `Message`, `StreamEvent` | The neutral request and response shapes |
| `modelSchema(jsonSchema)` | A JSON Schema as structured output accepts it |
| `sse(textStream)` | A `Responsable` streaming server-sent events |
| `AiOutputError` | The answer is not JSON or breaks the `output` schema (`text`, `issues`) |
| `AiRefusalError` | The model declined (`category`) |
| `AiFake`, `installAiFake(app)` | `fakes: ['ai']`: `respond`, `assertRan`, `assertNotRan`, `ran`, `runs` |
