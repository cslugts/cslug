# @cslug/cli

`bin: cslug`. Finds the app (the nearest folder with `bootstrap/app.ts`), calls `createApp()`, registers the
providers (no connections yet) and runs the command. Commands with `static boot = false` (generators,
`key:generate`, `start`, `dev`) never boot the providers, so they work without a database.

Where commands come from:

| Source | How |
|---|---|
| built-in | `list`, `about`, `config:show`, `key:generate`, `key:rotate`, `dev:cert`, `add`, `describe`, `mcp:dev`, `agents:sync`, `repl`, `start`, `dev`, `make:command/provider/event/listener/service/test`, `make:crud` |
| packages | their provider calls `this.commands([...])` in `register()`. @cslug/http: `serve`, `routes`, `make:controller/validator/middleware`. @cslug/database: `migrate`, `migrate:status/rollback/fresh`, `db:seed`, `make:migration/table/repository/factory/seeder` |
| your app | classes exported from `app/commands/**/*-command.ts`, imported only when needed. A file that fails to import is skipped with a warning |

`cslug start` runs each role as a child process (`serve`, `queue:work`, `schedule:work`), restarts crashed
ones with backoff, forwards SIGTERM and exits 0 once they have all drained. `cslug dev` runs the same processes
under `bun --watch` with `CSLUG_DEV=1`; islands are hot-updated when `.vue` files change (`--no-hmr` sets
`CSLUG_HMR=0`: pages reload instead). Roles whose command is not installed are skipped with a warning.

## `cslug add`

`cslug add queue` (or several: `cslug add queue,mail`) installs a package and wires it:

| Name | Installs | Wires |
|---|---|---|
| `queue` | `@cslug/queue` | `QueueProvider`, `ScheduleProvider`; `config/queue.ts`; `routes/schedule.ts`; a worker and the scheduler in `cslug.config.ts` |
| `mail` | `@cslug/mail` | `MailProvider`; `config/mail.ts` (log transport, SMTP for Mailpit) |
| `storage` | `@cslug/storage` | `StorageProvider`; `config/storage.ts` |
| `notification` | `@cslug/notification` | `NotificationProvider`; `config/notification.ts`; then `cslug migrate` |
| `webhook` | `@cslug/webhook` | `WebhookProvider`; `config/webhooks.ts`; then `cslug migrate` |
| `security` | `@cslug/security` | `SecurityProvider`; `config/security.ts` (CSP, a per-IP limit, IP filter, `security.txt` from `SECURITY_CONTACT`, lockout, audit log); then `cslug migrate` |
| `workflow` | `@cslug/workflow` | `WorkflowProvider`; then `cslug migrate` (needs `queue`) |
| `ai` | `@cslug/ai` | `AiProvider`; `config/ai.ts` (Anthropic, roles `fast` and `smart`) |
| `tailwind` | `tailwindcss`, `bun-plugin-tailwind` (dev) | `resources/styles/tailwind.css`, its import in `resources/client.ts`, `assets.tailwind: true` |

`@cslug/*` packages are installed at the CLI's own version (every package of a release shares it). Providers go into
`bootstrap/providers.ts` before `AppServiceProvider`; config files are written only when missing and listed in
`config/index.ts`. Running it again changes nothing. When a file does not have the shape `bun create cslug` writes,
it says what to add by hand. `--no-install` edits the files without running `bun add`.

## `cslug describe` and `cslug repl`

`cslug describe [section] [--json]` prints the app as data: a summary of the sections, one section, or everything
with `--json`. The CLI has `providers` and `config` (keys only); packages add theirs with `this.describe(name, fn)`
in a provider: `routes` (http), `tables` (database, from `app/tables/`), `jobs` and `schedules` (queue).

`cslug mcp:dev` serves development tools over MCP (stdio) for coding agents: `describe`, `routes`, `tables`,
`query` (read-only transaction, 5 s statement timeout, rows limited; needs @cslug/database), `logs` and `last_error`
(from `.cslug/dev.log`), `run_test` (`bun test [path] [-t name]` in the app, 3 min timeout) and `docs_search`
(sections of `node_modules/@cslug/*/docs`). Logs go to stderr; it refuses to run in production. `devTools(app)`
returns the tools (`McpTool[]` from @cslug/core). `cslug dev` writes every line its children print to
`.cslug/dev.log` as JSON lines (`{ t, role, stream, line }`), emptied at each start (`DEV_LOG`; the supervisor's
`logFile` option).

`cslug agents:sync [--check] [--file=AGENTS.md]` writes the generated sections of `AGENTS.md` between
`<!-- cslug:begin name -->` and `<!-- cslug:end name -->` markers: `stack`, `rules`, `layout`, `commands`, `app`
(routes, tables, jobs, schedules from the describe sections) and `tools`. Text outside the markers is kept as is; a
missing section is appended unless `<!-- cslug:off name -->` is in the file; a new file starts with a header for
hand-written notes. The output is deterministic, so `--check` (exit 1 when out of date, no write) suits CI.
`mergeAgents(existing, sections, title?)` and `agentsSections(app, commands)` are exported.

`cslug repl` boots the app and reads TypeScript lines: top-level `await`, declarations kept between lines, an open
brace continues on the next line. In scope: `app`, `resolve`, `config` and the exports of `app/tables/` and
`app/repositories/`. `evaluate(code, scope)` and `replScope(app)` are exported for tools.

