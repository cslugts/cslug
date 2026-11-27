# @cslug/cli: API

## Writing a command

`Command`, `arg` and `flag` come from @cslug/core (so packages can contribute commands) and are re-exported
here.

```ts
@inject(DocumentRepository)
export class ExpireDocumentsCommand extends Command {
  static signature = 'operators:expire-documents'
  static description = 'Mark expired operator documents'
  static args = { before: arg.date().optional(), dryRun: flag.boolean().alias('n') }
  constructor(private documents: DocumentRepository) { super() }
  async handle({ before, dryRun }: Command.Args<typeof ExpireDocumentsCommand>) { … }
}
```

| Static | |
|---|---|
| `signature` | `group:name` |
| `description` | shown by `list` and `--help` |
| `args` | `arg.string/number/date()` (positional, in order), `flag.boolean/string/number/date/list()`; modifiers `.optional()`, `.default(v)`, `.describe()`, `.alias('x')`, `.choices(...)`. camelCase keys are written in kebab-case (`--dry-run`); `--no-x` negates a boolean |
| `boot` | `false`: don't boot providers (no connections) |
| `longRunning` | the process stays up until a signal (`serve`, `queue:work`) |

`handle(args)` may return an exit code. Usage errors exit 2 with the help text; other errors exit 1.

Helpers: `line`, `info`, `success`, `warn`, `error`, `table(rows)`, `confirm(q, fallback)`, `ask`, `choose`,
`progress(n)`, `generate(stubDir, stub, target, vars, force)` (for generators: the app's `stubs/<stub>` wins),
plus `app`, `clock`, `log`, `io`. When the session is not interactive, prompts return the fallback.

`names('admin/Claim', 'controller')` gives the generator names (`ClaimController`, `admin/claim-controller`, …).

## Exports

| | |
|---|---|
| `CliKernel(app)` | `.run(argv)` → exit code; `.commands()` |
| `Supervisor(specs, options)` | `.start()`, `.stop(signal)` → exit code; options `cwd`, `bunFlags`, `env`, `shutdownTimeout`, `log`, `prefix`, `logFile`; `plannedProcesses(config, flags)` |
| `DEV_LOG` | `.cslug/dev.log`, where `cslug dev` appends what its processes print |
| `generator(kind, dir, description)` | a `make:<kind>` command from `stubs/<kind>.stub` |
| `AddCommand`, `ADDITIONS` | `cslug add <names>` and what each name installs and wires |
| `DescribeCommand` | `cslug describe [section] [--json]`; `describeSections(app)` |
| `McpDevCommand`, `devTools(app)` | `cslug mcp:dev`; the tools it serves (`McpTool[]`) |
| `ReplCommand`, `evaluate(code, scope)`, `replScope(app)` | `cslug repl` and its evaluator |
| `BufferedIO(answers?)` | capture output in tests: `app.instance(ConsoleIO, io)` |
| `defineCslugConfig()` | `cslug.config.ts`: `processes` (`web.instances`, `worker[]`, `scheduler`), `shutdownTimeout`, `assets` |
| `commandHelp(cmd)` | |
