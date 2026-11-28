# Directory structure

Two layouts: the **app** a developer works in every day, and the **framework repo** we build.

## 1. A cslug application: grouped by type ✅

```
my-app/
├── app/
│   ├── controllers/                       # HTTP controllers
│   │   ├── booking-controller.ts
│   │   ├── circuit-controller.ts
│   │   ├── payment-webhook-controller.ts
│   │   └── admin/                         # subfolders are fine: app/controllers/admin/operator-controller.ts
│   ├── validators/                        # request / payload schemas and Validator classes
│   │   ├── store-trip-request-validator.ts
│   │   └── accept-proposal-validator.ts
│   ├── policies/                          # booking-policy.ts, operator-policy.ts
│   ├── services/                          # domain logic + external gateways
│   │   ├── escrow-service.ts
│   │   ├── payment-gateway.ts             # abstract class (the "interface")
│   │   └── mangopay-gateway.ts            # concrete implementation
│   ├── repositories/                      # booking-repository.ts, operator-repository.ts
│   ├── tables/                            # table definitions + row types: booking-table.ts
│   ├── enums/                             # plain TS: booking-status.ts (states + transitions)
│   ├── exceptions/                        # error handlers: payment-declined-handler.ts (own pages and JSON)
│   ├── jobs/                              # send-checkin-job.ts
│   ├── workflows/                         # booking-deposit-workflow.ts (@cslug/workflow)
│   ├── events/                            # booking-deposit-paid.ts
│   ├── listeners/                         # update-reliability-badge-listener.ts
│   ├── mail/                              # mailables: booking-confirmed-mail.ts
│   ├── notifications/                     # checkin-due-notification.ts
│   ├── middleware/                        # require-verified-operator-middleware.ts
│   ├── commands/                          # expire-documents-command.ts
│   ├── providers/                         # app-service-provider.ts, payment-service-provider.ts
│   ├── transformers/                      # JSON shapes for APIs: operator-transformer.ts
│   ├── agents/                            # AI agents: offer-extractor-agent.ts
│   ├── tools/                             # AI tools: find-operators-tool.ts
│   └── support/                           # helpers and base classes that fit nowhere else
├── bootstrap/
│   ├── app.ts                             # createApp() — the only place an Application is built
│   └── providers.ts                       # ordered provider list
├── config/                                # one file per module: app, database, redis, queue, mail, …
│   └── env.ts                             # the env schema, validated at boot
├── database/
│   ├── migrations/                        # SQL files: 20261126_101500_create_bookings.sql
│   ├── seeders/
│   └── factories/
├── resources/
│   ├── views/                             # pages + layouts (*.vue): server-rendered, never hydrated
│   │   ├── layouts/default.vue
│   │   ├── circuits/show.vue
│   │   └── bookings/show.vue
│   ├── components/                        # Vue components: static, or islands with `hydrate="…"`
│   ├── mail/                              # mail templates (*.vue)
│   ├── styles/                            # app.scss, _tokens.scss (or tailwind.css)
│   ├── lang/                              # fr.json, en.json, it.json
│   └── client.ts                          # browser entry: mounts islands, imports app.scss
├── routes/
│   ├── web.ts                             # HTML pages (session, CSRF)
│   ├── api.ts                             # JSON / webhooks
│   ├── schedule.ts                        # scheduled tasks
│   └── console.ts                         # closure commands (optional)
├── public/                                # static files served as-is; build output in public/build
├── storage/                               # local disk, logs (gitignored)
├── tests/
│   ├── feature/                           # HTTP + DB, one file per flow
│   └── unit/
├── AGENTS.md                              # generated + hand-edited; read by AI coding agents
├── cslug.config.ts                        # framework-level settings (paths, discovery)
├── package.json                           # "imports": { "#app/*": "./app/*", "#config/*": "./config/*", "#views/*": "./resources/views/*", "#resources/*": "./resources/*", "#components/*": "./resources/components/*", "#database/*": "./database/*", "#routes/*": "./routes/*", … }
└── tsconfig.json
```

### Rules

- **The folder is the type.** `app/controllers/`, `app/jobs/`, `app/listeners/`, … Discovery (jobs for the
  worker, workflows, commands for the CLI, tables for the migration differ, listeners, tools) scans these folders,
  including subfolders.
- **File name = exported class, in kebab-case**, with the role as the last word:
  `BookingRepository` → `booking-repository.ts`, `SendCheckinJob` → `send-checkin-job.ts`,
  `StoreTripRequestValidator` → `store-trip-request-validator.ts`. **No dots** in file names except the
  extension (and `.test.ts`, which `bun test` needs).
- **One exported class per file.** Tables export a constant and its row type (`booking-table.ts` →
  `bookings`, `Booking`). Events are past-tense names without a suffix (`booking-deposit-paid.ts` →
  `BookingDepositPaid`).
- **Subfolders for areas**, not for types: `app/controllers/admin/`, `app/services/payments/`. Use them when a
  folder passes ~15 files.
- **Imports use subpath aliases**: `#app/repositories/booking-repository`, `#config/mail`. No `../../..`.
- **Views are imported, not named**: `view(ShowBooking, props)` with
  `import ShowBooking from '#views/bookings/show.vue'`, so `cslug typecheck` (vue-tsc) checks the props.
- **Components become islands where they are used**: `<DayCard :day="day" hydrate="visible" />`. There is no
  separate islands folder.
- **Generators know the layout**: `cslug make:listener UpdateBadge` → `app/listeners/update-badge-listener.ts`;
  `cslug make:controller admin/Operator` → `app/controllers/admin/operator-controller.ts`.

## 2. The framework repository (this repo)

```
bun/
├── packages/
│   ├── validation/                        # @cslug/validation
│   ├── core/                              # @cslug/core
│   ├── http/                              # @cslug/http
│   ├── vue/                               # @cslug/vue
│   ├── database/                          # @cslug/database
│   ├── redis/                             # @cslug/redis
│   ├── queue/                             # @cslug/queue (incl. scheduler)
│   ├── auth/                              # @cslug/auth
│   ├── mail/                              # @cslug/mail
│   ├── notification/                      # @cslug/notification
│   ├── storage/                           # @cslug/storage
│   ├── webhook/                           # @cslug/webhook
│   ├── ai/                                # @cslug/ai
│   ├── cli/                               # @cslug/cli (the `cslug` binary)
│   ├── testing/                           # @cslug/testing
│   └── create-cslug/                      # `bun create cslug` scaffolder (literal template files)
├── apps/
│   └── starter-kit/                       # reference app: todos, exercises most packages
├── docs/                                  # this documentation
├── guides/
├── scripts/release.ts                     # lockstep version bump + publish in dependency order
├── CHANGELOG.md
├── docker-compose.yml                     # postgres 17, redis 7, mailpit
└── package.json                           # workspaces: packages/*, apps/*
```

Each package has the same shape:

```
packages/queue/
├── src/
│   ├── index.ts                           # the public API: everything importable from @cslug/queue
│   ├── job.ts
│   ├── redis-stream-driver.ts             # same file naming as apps: kebab-case, no dots
│   ├── schedule/…
│   └── queue-provider.ts
├── tests/
├── stubs/                                 # generator templates this package contributes (make:table, …)
├── docs/                                  # README.md + api.md, shipped in the npm package
└── package.json                           # "peerDependencies": { "@cslug/core": "0.1.0", "@cslug/redis": "0.1.0" }
```

**The pilot app is the real test.** Besides the starter kit, the framework is validated by building a private
product's riskiest flows first (operator verification, escrow, check-ins — the MVP build order) in its own repository.
