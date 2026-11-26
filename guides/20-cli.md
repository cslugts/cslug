# CLI & commands

One binary: `cslug`, from `@cslug/cli` (`bunx cslug`, or `bun cslug` via the package script). Commands come from the
installed packages: `migrate` exists only with `@cslug/database`, `queue:work` only with `@cslug/queue`.

## Built-in commands

| Group | Commands |
|---|---|
| Run | `dev`, `serve`, `start` (supervisor: web + worker + scheduler), `build`, `typecheck`, `repl` |
| Database | `migrate`, `migrate:status`, `migrate:rollback`, `migrate:fresh`, `db:seed`, `db:shell` |
| Queue | `queue:work`, `queue:health`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:clear`, `queue:stats` |
| Schedule | `schedule:work`, `schedule:run`, `schedule:list`, `schedule:history`, `schedule:test` |
| Inspect | `routes`, `events`, `config:show`, `describe`, `about` |
| Make | `make:controller`, `make:validator`, `make:table`, `make:repository`, `make:migration`, `make:job`, `make:listener`, `make:event`, `make:mail`, `make:notification`, `make:policy`, `make:command`, `make:provider`, `make:view`, `make:component`, `make:factory`, `make:agent`, `make:tool`, `make:test`, `make:crud` |
| i18n | `i18n:check`, `i18n:extract` |
| Mail | `mail:preview` |
| AI | `ai:prompts`, `ai:record`, `ai:eval`, `mcp:serve`, `mcp:dev`, `agents:sync` |
| Misc | `key:generate`, `webhooks:replay`, `add tailwind` |

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

Commands are discovered in `app/commands/`. Output helpers: `info`, `success`, `warn`, `error`, `table`, `confirm`, `ask`,
`choose`, `progress`. `this.clock`, `this.log` are available on the base class.

## REPL

```bash
$ cslug repl
cslug> const b = await resolve(BookingRepository).findByOrFail({ ref: 'ALB-7K2Q9F' })
cslug> b.status
'deposit_paid'
```

Top-level `await`, `resolve()`, all tables and repositories pre-imported.

## `describe`

```bash
cslug describe                   # summary
cslug describe routes --json     # routes with middleware, validator and JSON Schema of the body
cslug describe tables --json     # tables, columns, types, indexes, foreign keys
cslug describe jobs --json       # jobs, queues, tries, backoff, payload schema
```

Designed for scripts and AI coding agents; see [docs/ai-readiness.md](../docs/ai-readiness.md).
