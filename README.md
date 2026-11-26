# cslug

A small, Laravel-flavoured web framework for **Bun + TypeScript + PostgreSQL + Redis + Vue**.

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

- **Laravel's shape:** container with `@inject`, service providers, controllers, validators, policies, jobs,
  mail, a scheduler, one CLI (`cslug`).
- **Bun first, almost zero dependencies:** `Bun.serve`, `Bun.sql`, `Bun.redis`, `Bun.password`, `Bun.s3`.
  The only third-party runtime package is `vue`, for apps with HTML pages.
- **Vue everywhere:** pages rendered on the server, components hydrated as islands where you add `hydrate`.
- **Correct by default for money:** ambient transactions, after-commit dispatch, idempotent webhooks,
  once-per-tick schedules, integer money.
- **Install only what you use:** 15 packages under `@cslug/*`; an API never installs Vue, an app without AI
  never installs `@cslug/ai`.

> **Status: in development.** The specification is complete; packages are being implemented milestone by
> milestone. See [docs/implementation-plan.md](./docs/implementation-plan.md).

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
