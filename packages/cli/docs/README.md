# @cslug/cli

`bin: cslug`. Finds the app (the nearest folder with `bootstrap/app.ts`), calls `createApp()`, registers the
providers (no connections yet) and runs the command. Commands with `static boot = false` (generators,
`key:generate`, `start`, `dev`) never boot the providers, so they work without a database.

Where commands come from:

| Source | How |
|---|---|
| built-in | `list`, `about`, `config:show`, `key:generate`, `add`, `start`, `dev`, `make:command/provider/event/listener/service/test` |
| packages | their provider calls `this.commands([...])` in `register()`. @cslug/http: `serve`, `routes`, `make:controller/validator/middleware`. @cslug/database: `migrate`, `migrate:status/rollback/fresh`, `db:seed`, `make:migration/table/repository/factory/seeder` |
| your app | classes exported from `app/commands/**/*-command.ts`, imported only when needed. A file that fails to import is skipped with a warning |

`cslug start` runs each role as a child process (`serve`, `queue:work`, `schedule:work`), restarts crashed
ones with backoff, forwards SIGTERM and exits 0 once they have all drained. `cslug dev` runs the same processes
under `bun --watch`. Roles whose command is not installed are skipped with a warning.

## `cslug add`

`cslug add queue` (or several: `cslug add queue,mail`) installs a package and wires it:

| Name | Installs | Wires |
|---|---|---|
| `queue` | `@cslug/queue` | `QueueProvider`, `ScheduleProvider`; `config/queue.ts`; `routes/schedule.ts`; a worker and the scheduler in `cslug.config.ts` |
| `mail` | `@cslug/mail` | `MailProvider`; `config/mail.ts` (log transport, SMTP for Mailpit) |
| `storage` | `@cslug/storage` | `StorageProvider`; `config/storage.ts` |
| `notification` | `@cslug/notification` | `NotificationProvider`; `config/notification.ts`; then `cslug migrate` |
| `webhook` | `@cslug/webhook` | `WebhookProvider`; `config/webhooks.ts`; then `cslug migrate` |
| `tailwind` | `tailwindcss`, `bun-plugin-tailwind` (dev) | `resources/styles/tailwind.css`, its import in `resources/client.ts`, `assets.tailwind: true` |

`@cslug/*` packages are installed at the CLI's own version (every package of a release shares it). Providers go into
`bootstrap/providers.ts` before `AppServiceProvider`; config files are written only when missing and listed in
`config/index.ts`. Running it again changes nothing. When a file does not have the shape `bun create cslug` writes,
it says what to add by hand. `--no-install` edits the files without running `bun add`.

