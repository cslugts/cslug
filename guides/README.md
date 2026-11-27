# cslug guides

Developer-facing guides. They are written **before** the code, to decide whether the API feels right.
Every snippet is meant to compile against the final framework; if one can't, the API or the guide changes.

> New here? Read [00 — A tour](./00-tour.md) first: one feature through every layer.

| # | Guide | |
|---|---|---|
| 00 | [A tour: protected booking deposit](./00-tour.md) | End-to-end, every layer |
| 01 | [Getting started](./01-getting-started.md) | Create, run, first page |
| 02 | [Container & `@inject()`](./02-container-and-di.md) | `@inject(A, B)`, scopes, interfaces, tokens |
| 03 | [Service providers](./03-service-providers.md) | register → boot → shutdown |
| 04 | [Configuration & env](./04-configuration.md) | Typed config, validated env |
| 05 | [Routing & middleware](./05-routing-and-middleware.md) | Routes file, groups, names, middleware |
| 06 | [Controllers](./06-controllers.md) | Actions, context, responses |
| 07 | [Validation](./07-validation.md) | `v`, `Validator`, errors, forms |
| 08 | [Views: Vue on the server, islands, SCSS, Tailwind](./08-views-vue-scss.md) | Views, layouts, components, islands, forms, assets |
| 09 | [Database](./09-database.md) | Typed tables, query builder, `sql` tag, repositories, migrations |
| 10 | [Cache & locks](./10-cache.md) | Redis cache, `remember`, atomic locks, rate limits |
| 11 | [Queues & jobs](./11-queues-and-jobs.md) | Jobs, retries, after-commit, durable dispatch |
| 12 | [Scheduler](./12-scheduler.md) | `routes/schedule.ts`, once-per-tick |
| 13 | [Events](./13-events.md) | Typed events, queued listeners |
| 14 | [Mail & notifications](./14-mail-and-notifications.md) | Vue mail templates, channels, WhatsApp |
| 15 | [Auth & authorization](./15-auth-and-authorization.md) | Sessions, magic links, tokens, policies |
| 16 | [i18n](./16-i18n.md) | FR / EN / IT, money and dates |
| 17 | [Storage & webhooks](./17-storage-and-webhooks.md) | Uploads, signed URLs, verified idempotent webhooks |
| 18 | [AI](./18-ai.md) | Agents, tools, structured output, MCP |
| 19 | [Testing](./19-testing.md) | `testApp()`, fakes, DB isolation |
| 20 | [CLI & commands](./20-cli.md) | `cslug`, generators, custom commands |
| 21 | [Deployment](./21-deployment.md) | Processes, Docker, health checks |
| 22 | [Search](./22-search.md) | Full-text search over tables: languages, accents, ranking, highlights |
| 23 | [Observability](./23-observability.md) | Logs, traces and metrics: OpenTelemetry export, `/metrics` |
