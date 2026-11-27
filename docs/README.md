# cslug

> **Status:** design phase — nothing is implemented yet. These documents are the specification.
> The developer guides in [`../guides/`](../guides) exist to **validate the DX before any code is written**.
> Sign-off on both is the gate before implementation starts.

**cslug** is a small, Laravel-flavoured web framework for **Bun + TypeScript + PostgreSQL + Redis + Vue**.
It is built first to ship the MVP of a private pilot app (a travel booking platform with escrowed payments) and nothing
it does not need.

```ts
@inject()
export class BookingController {
  constructor(private bookings: BookingRepository, private escrow: EscrowService) {}

  async store({ request, auth }: HttpContext) {
    const data = await request.validate(StoreBookingValidator)
    const booking = await this.escrow.openBooking(auth.user(), data)
    return redirect().route('bookings.show', { id: booking.id }).with('success', t('bookings.created'))
  }
}
```

## Reading order

| # | Document | What it settles |
|---|---|---|
| 1 | [principles.md](./principles.md) | What "simpler Laravel" means in practice; the rules every module follows |
| 2 | [decisions.md](./decisions.md) | The key technical choices, the alternatives, and why. **Start here if you only have 15 minutes** |
| 3 | [packages.md](./packages.md) | The `@cslug/*` packages, what each one owns, dependencies, versioning |
| 4 | [directory-structure.md](./directory-structure.md) | How a cslug app is laid out (and how the framework repo is laid out) |
| 5 | [architecture.md](./architecture.md) | Container, providers, kernels, request/job/command lifecycles |
| 6 | [conventions.md](./conventions.md) | Naming, files, errors, money, IDs, time |
| 7 | [ai-readiness.md](./ai-readiness.md) | How cslug is ready for AI features *and* for AI coding agents |
| 8 | [open-questions.md](./open-questions.md) | Decisions still needed before coding |
| 9 | [implementation-plan.md](./implementation-plan.md) | Repos, accounts, and the milestone order for building the packages |
| — | [`../guides/`](../guides/README.md) | Developer-facing guides, one per feature, with code |

## Relationship to earlier work

- **An earlier requirements draft** (kept privately with the pilot app) was an input. Its *correctness* requirements
  (idempotency, job leases, once-per-tick scheduling, RFC 9457 errors, money as minor units, UUIDv7)
  are carried over. Its *structural* choices (no decorators, no Redis, no views, `src/core` + `src/app`)
  are **superseded** — see [decisions.md](./decisions.md).
- **strav 1.x**, an earlier internal attempt, is a reference only. Nothing is ported. What we learned from it is
  listed in [decisions.md § Lessons from strav](./decisions.md#lessons-from-strav).

## Documentation policy (once implementation starts)

| Surface | Authority | Purpose |
|---|---|---|
| `docs/*.md` | Canonical | Cross-cutting design: architecture, conventions, decisions |
| `docs/<module>/` | Canonical, code-aligned | Created per module *during* implementation: `README.md` + `api.md`. Ships in the same commit as the code |
| `guides/` | Canonical for DX | How a developer uses the framework. If the code makes a guide example impossible, either the code or the guide changes, in the same commit |
