# CLI & commands

One binary: `cslug`, from `@cslug/cli` (`bunx cslug`, or `bun cslug` via the package script). Commands come from the
installed packages: `migrate` exists only with `@cslug/database`, `queue:work` only with `@cslug/queue`.

## Built-in commands

| Group | Commands |
|---|---|
| Run | `dev`, `serve`, `start` (supervisor: web + worker + scheduler), `build`, `typecheck`, `repl` |
| Database | `migrate`, `migrate:status`, `migrate:rollback`, `migrate:fresh`, `db:seed`, `db:diff`, `db:shell` |
| Queue | `queue:work`, `queue:health`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:clear`, `queue:stats` |
| Schedule | `schedule:work`, `schedule:run`, `schedule:list`, `schedule:history`, `schedule:test` |
| Inspect | `routes`, `events`, `config:show`, `describe`, `about` |
| Make | `make:controller`, `make:validator`, `make:table`, `make:repository`, `make:migration`, `make:job`, `make:listener`, `make:event`, `make:mail`, `make:notification`, `make:policy`, `make:command`, `make:provider`, `make:view`, `make:component`, `make:factory`, `make:agent`, `make:tool`, `make:test`, `make:crud` |
| i18n | `i18n:check`, `i18n:extract` |
| Mail | `mail:preview` |
| AI | `ai:prompts`, `ai:record`, `ai:eval`, `mcp:serve`, `mcp:dev`, `agents:sync` |
| Misc | `key:generate`, `webhooks:replay`, `add` |

Every command supports `--help`; inspect commands support `--json`.

## Generators

```bash
cslug make:job SendCheckin                    # app/jobs/send-checkin-job.ts
cslug make:controller admin/Claim --resource  # app/controllers/admin/claim-controller.ts
cslug make:crud Claim                         # claim-table, claim-repository, claim-controller, claim-policy,
                                              # store-claim-validator, views and a feature test
cslug make:view claims/show                   # resources/views/claims/show.vue with a typed defineProps stub
cslug make:component claim-timeline           # resources/components/claim-timeline.vue (use with hydrate=… to make an island)
```

## Adding a package

```bash
cslug add queue,mail        # bun add @cslug/queue @cslug/mail (at the CLI's version), providers, config/queue.ts,
                            # config/mail.ts, routes/schedule.ts, a worker and the scheduler in cslug.config.ts
```

Names: `queue`, `mail`, `storage`, `notification`, `webhook`, `ai`, `tailwind`. Running it twice changes nothing.

Stubs are literal files in `stubs/` and can be published to the app (`cslug stubs:publish`) to customise them.
Generators never overwrite without `--force` and print every file they write.

## Writing a command

```ts
// app/commands/expire-documents-command.ts
import { inject } from '@cslug/core'
import { Command, arg, flag } from '@cslug/cli'
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

Commands are discovered in `app/commands/` (files named `*-command.ts`). Output helpers: `info`, `success`, `warn`,
`error`, `table`, `confirm`, `ask`, `choose`, `progress`. `this.clock`, `this.log` are available on the base class.
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
