# CLI & commands

One binary: `cslug`, from `@cslug/cli` (`bunx cslug`, or `bun cslug` via the package script). Commands come from the
installed packages: `migrate` exists only with `@cslug/database`, `queue:work` only with `@cslug/queue`.

## Commands

| Group | Commands | From |
|---|---|---|
| Run | `dev`, `start` (supervisor: web + worker + scheduler), `serve`, `build`, `typecheck`, `repl`, `list` | cli, http, vue |
| Inspect | `routes`, `describe`, `config:show`, `about` | cli, http |
| Keys | `key:generate`, `key:rotate` | cli |
| Database | `migrate`, `migrate:status`, `migrate:rollback`, `migrate:fresh`, `db:seed`, `db:diff`, `db:shell`, `db:reencrypt` | database |
| Queue | `queue:work`, `queue:health`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:clear`, `queue:stats` | queue |
| Schedule | `schedule:work`, `schedule:run`, `schedule:list`, `schedule:history`, `schedule:test` | queue |
| Workflows | `workflow:list`, `workflow:show`, `workflow:retry`, `workflow:cancel`, `workflow:prune` | workflow |
| Make | see below | cli, http, database |
| Mail | `mail:preview` | mail |
| Webhooks | `webhooks:replay` | webhook |
| Search | `search:reindex` | search |
| Security | `audit:prune` | security |
| AI | `ai:prompts`, `ai:record`, `ai:eval`, `mcp:serve` | ai |
| Agents | `mcp:dev`, `agents:sync` | cli |
| Packages | `add` | cli |

`cslug list` shows what the installed packages give this app. Every command supports `--help`; inspect commands
support `--json`. Options are written in kebab-case (`--dry-run`, `--older-than=90d`); `-c` style aliases exist where
a command declares them.

## Generators

| Command | Writes |
|---|---|
| `make:controller Claim [--resource]` | `app/controllers/claim-controller.ts` (`--resource`: the seven REST actions) |
| `make:middleware RequireVerifiedOperator` | `app/middleware/require-verified-operator-middleware.ts` |
| `make:validator StoreClaim` | `app/validators/store-claim-validator.ts` |
| `make:table Claim` | `app/tables/claim-table.ts` (the `claims` table with `id` and timestamps) |
| `make:repository Claim` | `app/repositories/claim-repository.ts` |
| `make:migration [name] [--from-tables]` | `database/migrations/<timestamp>_<name>.sql`: empty, or the SQL for what `app/tables/` changed (guide 09) |
| `make:factory Claim` / `make:seeder Pilot` | `database/factories/claim-factory.ts` / `database/seeders/pilot-seeder.ts` |
| `make:command ExpireDocuments` | `app/commands/expire-documents-command.ts` |
| `make:provider Payments` | `app/providers/payments-provider.ts` |
| `make:event OperatorVerified` / `make:listener UpdateBadge` | `app/events/…`, `app/listeners/…` |
| `make:service Escrow` | `app/services/escrow-service.ts` |
| `make:test Claims` | `tests/claims.test.ts` |

```bash
cslug make:controller admin/Claim --resource  # a folder: app/controllers/admin/claim-controller.ts
```

Names are given in PascalCase (or kebab-case) and may include folders. Generators never overwrite without `--force`
and print every file they write. To change what they write, put your own template in the app's `stubs/` folder
under the same name (`stubs/service.stub`, `stubs/controller.stub` …): it wins over the package's. Templates use
`{{ class }}`, `{{ base }}`, `{{ kebab }}`, `{{ snake }}` and `{{ camel }}`. Jobs, mailables, notifications, policies, views and components have no generator
yet: they are one small file each (guides 11, 14, 15, 08).

## Adding a package

```bash
cslug add queue,mail        # bun add @cslug/queue @cslug/mail (at the CLI's version), providers, config/queue.ts,
                            # config/mail.ts, routes/schedule.ts, a worker and the scheduler in cslug.config.ts
```

Names: `queue`, `mail`, `storage`, `notification`, `webhook`, `search`, `telemetry`, `security`, `workflow`, `ai`,
`tailwind`. Running it twice changes nothing. A file it cannot edit is reported with what to add by hand; `--no-install`
only edits files.

## Writing a command

```ts
// app/commands/expire-documents-command.ts
import { inject } from '@cslug/core'
import { arg, Command, flag } from '@cslug/core'          // also re-exported by @cslug/cli
import { OperatorDocumentRepository } from '#app/repositories/operator-document-repository'

@inject(OperatorDocumentRepository)
export class ExpireDocumentsCommand extends Command {
  static signature = 'operators:expire-documents'
  static description = 'Mark expired operator documents and suspend badges that depend on them.'
  static args = {
    before: arg.date().optional().describe('Treat documents expiring before this date as expired'),
    dryRun: flag.boolean().describe('Show what would change'),
  }

  constructor(private documents: OperatorDocumentRepository) { super() }

  async handle({ before, dryRun }: Command.Args<typeof ExpireDocumentsCommand>) {
    const expired = await this.documents.expiringBefore(before ?? this.clock.today())
    this.table(expired.map((d) => ({ operator: d.operatorId, kind: d.kind, expires: d.expiresOn })))
    if (dryRun || !(await this.confirm(`Expire ${expired.length} documents?`))) return
    await this.documents.markExpired(expired.map((d) => d.id))
    this.success(`${expired.length} documents expired`)
  }
}
```

Arguments are typed from `static args`:

| Spec | Written | Value |
|---|---|---|
| `arg.string()`, `arg.number()`, `arg.date()` | positional, in declaration order | `string`, `number`, `'YYYY-MM-DD'` |
| `flag.boolean()` | `--dry-run` | `true` / `false` |
| `flag.string()`, `flag.number()`, `flag.date()` | `--older-than=90d`, `--limit 20` | |
| `flag.list()` | `--queues=a,b` or `--queues a --queues b` | `string[]` |
| `.optional()`, `.default(v)`, `.describe(text)`, `.alias('c')`, `.choices('a', 'b')` | | `.choices` narrows the type |

A missing or wrong argument prints the usage and exits 2 (`--help` shows it all).

Commands are discovered in `app/commands/` (files named `*-command.ts`), imported only when needed. Output helpers:
`line`, `info`, `success`, `warn`, `error`, `table(rows)`, `progress`, and the prompts `confirm(question)` and
`ask(question)`. `this.app`, `this.clock`, `this.log` are available on the base class.
Return a number from `handle` to set the exit code (usage errors exit 2).

Commands boot the providers (database, Redis …) before `handle`. A command that doesn't need them declares
`static boot = false`. A command that keeps running (a server, a consumer) declares `static longRunning = true`.

Packages contribute commands from their provider:

```ts
export class PaymentsProvider extends ServiceProvider {
  register() {
    this.commands([ReconcilePaymentsCommand])
  }
}
```

## REPL

```bash
$ cslug repl
cslug> const b = await resolve(BookingRepository).findByOrFail({ ref: 'ALB-7K2Q9F' })
cslug> b.status
'deposit_paid'
```

TypeScript with top-level `await`. In scope: `app`, `resolve()`, `config()` and everything `app/tables/` and
`app/repositories/` export. Declarations (`const`, `let`, functions, classes) stay for the next lines; an open brace
continues on the next line. `.help` lists the names in scope, `.exit` leaves. Import other modules with
`await import('#app/services/escrow-service')`.

## `describe`

```bash
cslug describe                   # summary: each section and its size
cslug describe --json            # every section
cslug describe routes --json     # method, path, name, action, middleware
cslug describe tables --json     # tables, columns (type, nullable, unique, oneOf, default, references), indexes
cslug describe jobs --json       # jobs, queue, tries, backoff, timeout, payload JSON Schema (Job.schema)
cslug describe schedules         # name, when, timezone, job, overlap
cslug describe config            # config keys per file (never the values)
```

Sections come from the installed packages: a provider adds one with `this.describe('name', () => data)` in
`register()`.

Designed for scripts and AI coding agents; see [docs/ai-readiness.md](../docs/ai-readiness.md).

## `mcp:dev`

A development MCP server over stdio, for coding agents (Claude Code and others). Every app has it, with or without
`@cslug/ai`:

```json
{ "mcpServers": { "cslug": { "command": "bunx", "args": ["cslug", "mcp:dev"] } } }
```

| Tool | Gives the agent |
|---|---|
| `describe` | What `cslug describe` shows: the section sizes, or one section |
| `routes` | Routes, optionally filtered by path, name or action |
| `tables` | Tables declared in `app/tables/`, or one of them |
| `query` | One read-only SQL query on the development database (a read-only transaction, rolled back, 5 s timeout, 50 rows by default) |
| `logs` | What the app printed under `cslug dev` (its JSON log lines parsed), filtered by role, level or text |
| `last_error` | The latest error logged or printed, with the lines after it (the stack trace) |
| `run_test` | `bun test` for a file or folder and a name pattern: passed or not, and the end of the output |
| `docs_search` | The best matching sections of the installed `@cslug/*` docs, for the installed version |

`cslug dev` writes what its processes print to `.cslug/dev.log` (git-ignored, emptied at each start), which is where
`logs` and `last_error` read from. `mcp:dev` refuses to run when `app.env` is `production`.

## `agents:sync`

`AGENTS.md` tells coding agents how this app works. `cslug agents:sync` writes its generated sections and keeps
everything else as you wrote it:

```md
# AGENTS.md — My app

Glossary: a *circuit* is a multi-day route; an *operator* runs it.     ← yours, never touched

<!-- cslug:begin app -->
## This app
Routes (42, besides /health/*): …                                     ← rewritten by agents:sync
<!-- cslug:end app -->
```

| Section | Holds |
|---|---|
| `stack` | The installed `@cslug/*` packages, their versions and where their docs are |
| `rules` | The conventions, plus those of the installed packages (validation, authorization, islands, jobs, agents) |
| `layout` | The app's folders and what goes in each |
| `commands` | The `package.json` scripts and every `cslug` command, grouped |
| `app` | Routes, tables (columns, references), jobs and schedules, from `cslug describe` |
| `tools` | What to run before finishing, the `mcp:dev` configuration, the generators |

A new file gets a short header for your notes first. A section missing from the file is appended (so new ones
arrive with upgrades); `<!-- cslug:off routes -->` keeps one out. The output has no dates, so `cslug agents:sync
--check` can run in CI: it exits 1 when the file is out of date, and writes nothing.
