# @cslug/cli

`bin: cslug`. Finds the app (the nearest folder with `bootstrap/app.ts`), calls `createApp()`, registers the
providers (no connections yet) and runs the command. Commands with `static boot = false` (generators,
`key:generate`, `start`, `dev`) never boot the providers, so they work without a database.

Where commands come from:

| Source | How |
|---|---|
| built-in | `list`, `about`, `config:show`, `key:generate`, `start`, `dev`, `make:command/provider/event/listener/service/test` |
| packages | their provider calls `this.commands([...])` in `register()`. @cslug/http: `serve`, `routes`, `make:controller/validator/middleware`. @cslug/database: `migrate`, `migrate:status/rollback/fresh`, `db:seed`, `make:migration/table/repository/factory/seeder` |
| your app | classes exported from `app/commands/**/*-command.ts`, imported only when needed. A file that fails to import is skipped with a warning |

`cslug start` runs each role as a child process (`serve`, `queue:work`, `schedule:work`), restarts crashed
ones with backoff, forwards SIGTERM and exits 0 once they have all drained. `cslug dev` runs the same processes
under `bun --watch`. Roles whose command is not installed are skipped with a warning.
