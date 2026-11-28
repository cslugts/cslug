# cslug

A full-stack TypeScript framework built on **Bun**, with **PostgreSQL**, **Redis** and **Vue**. One process model,
one CLI, and a small set of packages that cover what a web product needs: routing, validation, a typed database
layer, auth, background jobs, scheduled tasks, email and webhooks.

```ts
@inject(BookingRepository, EscrowService)
export class BookingController {
  constructor(private bookings: BookingRepository, private escrow: EscrowService) {}

  async store({ request, auth }: HttpContext) {
    const data = await request.validate(StoreBookingValidator)
    const booking = await this.escrow.openBooking(auth.user(), data)
    return redirect().route('bookings.show', { id: booking.id }).with('success', t('bookings.created'))
  }
}
```

## Why cslug

- **Structure you don't have to invent.** Classes are wired by a typed container (`@inject`); providers register
  each package; controllers, validators, policies, jobs and mailables each have their place. The `cslug` CLI
  runs, builds, migrates and generates.
- **Built on what Bun already does well.** HTTP, SQL, Redis, password hashing and S3 come from Bun itself.
  Vue is the only third-party runtime dependency, and only for apps that render pages.
- **Server-rendered Vue.** Pages are rendered on the server; a component becomes interactive only where you mark it
  with `hydrate`, so most pages ship little or no JavaScript.
- **Safe defaults where mistakes cost money.** Transactions follow the request, jobs dispatched inside one wait
  for COMMIT, webhooks are processed exactly once, a scheduled task runs once per tick across servers, and
  amounts are integers in minor units.
- **Pay for what you use.** 15 packages under `@cslug/*`: an API never installs Vue, an app without AI never
  installs `@cslug/ai`.

## Status

Version **0.14.0** is on npm: HTTP, validation, database, Vue pages with HMR in development, auth, Redis, queue and scheduler, mail,
webhooks, notifications, storage, two-factor authentication, AI (agents, tools, MCP, conversations), search (full text, semantic, hybrid),
observability (log targets, OpenTelemetry traces and metrics, `/metrics`), encryption with `APP_KEY` rotation, security
(CSP nonces, IP filter, account lockout, breached-password check, audit log), state machines and durable workflows with sagas,
plus `cslug mcp:dev` and `cslug agents:sync` for coding agents. Start an app with `bun create cslug my-app`. See the
[implementation plan](./docs/implementation-plan.md) for the roadmap.

## Read

- [docs/](./docs/README.md): principles, decisions, packages, architecture, conventions
- [guides/](./guides/README.md): one guide per feature, with code. Start with [the tour](./guides/00-tour.md)
- [apps/starter-kit](./apps/starter-kit/README.md): a todo app written against the spec

## Repository

```
packages/      the @cslug/* packages (one folder each)
apps/          starter-kit (reference app)
docs/ guides/  specification and developer guides
scripts/       package-graph check, lockstep release
```

## Develop

```bash
bun install
docker compose up -d        # postgres, redis, mailpit
bun run check               # lint, typecheck, package-graph check, tests
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
