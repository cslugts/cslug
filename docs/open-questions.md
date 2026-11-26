# Open questions

## Decided (review of 2026-11-26)

| # | Question | Decision |
|---|---|---|
| Q0 | Name of the app | **Albastr** |
| Q3 | Inertia pages or server templates + Vue islands? | **Vue islands** ([D5](./decisions.md#d5-views-vue-on-the-server-components-hydrated-as-islands-)) |
| Q4 | Drizzle, or own typed tables + repositories? | **Own, no Drizzle** ([D6](./decisions.md#d6-database-own-typed-tables-repositories-and-query-builder-on-bunsql-)) |
| Q6 | Dependencies | **Almost zero**: no runtime deps; only `vue`, `sass`, `tailwindcss` as optional asset compilers ([D0](./decisions.md#d0-almost-zero-dependencies-)) |
| Q8 | Static shortcuts (`Job.dispatch()`, `view()`, `t()`) | **Yes** ([D9](./decisions.md#d9-static-shortcuts-)) |
| Q2 | Legacy or standard decorators? | **Standard**, `@inject(A, B)` ([D2](./decisions.md#d2-dependency-injection-standard-decorators-injecta-b-)) |
| Q5 | Folder layout and file names | **By type** (`app/controllers/`, …), `booking-repository.ts` ([D10](./decisions.md#d10-files-grouped-by-type-kebab-case-names-)) |
| Q1 | One package or several? | **Scoped packages `@cslug/*`** ([D1](./decisions.md#d1-scoped-packages-cslug-), [packages.md](./packages.md)) |
| Q14 | Server template language | **Vue** ([D5](./decisions.md#d5-views-vue-on-the-server-components-hydrated-as-islands-)) |
| Q15 | Islands rendered on the server by default? | **Yes** (`ssr={false}` per island to opt out) |
| Q16 | Queue engine | **Own, on Redis Streams** ([D8](./decisions.md#d8-redis-cache-locks-rate-limits-sessions-and-an-own-queue-on-redis-streams-)) |

## Still open

| # | Question | Recommendation | Affects |
|---|---|---|---|
| Q17 | SMTP: own client, or HTTP API transports only (Resend/Postmark/Brevo) in v1? | Both; the SMTP client is small and Mailpit needs it in dev | mail |
| Q7 | Ambient transactions (ALS) by default? | Yes; explicit `tx` also available (D7) | db, queue, events |
| Q9 | SCSS default with Tailwind opt-in? | Yes; `--tailwind` on create | scaffolder |
| Q10 | CLI binary name | `cslug` | docs |
| Q11 | Escrow payment partner (guides use "Mangopay" as a placeholder) | Confirm with the legal/escrow work | `app/payments` |
| Q12 | WhatsApp: Meta Cloud API directly or a provider? | Start manual (per MVP); keep the `whatsapp` channel | `@cslug/notification` |

## ✅ Resolved: Bun.sql runs a pooled query inside another transaction (found 2026-11-26)

**Symptom.** `database.test.ts` › "the context survives…" hung in CI twice (PRs #16, #19), and its `afterAll` too.

**Cause (Bun 1.3.14).** While a pool opens its connections under concurrency, `Bun.sql` can hand a connection
that is reserved for a transaction (by `begin()` or `reserve()`) to a plain pooled query. `pg_stat_activity`
then shows that connection as `idle in transaction` with the plain query (`select pg_sleep($1)`) as its last
statement. That query never resolves in JS, and the transaction never finishes. Beyond the hang, this means an
unrelated query can run **inside someone else's transaction**. Reproduced with plain `Bun.sql`, no cslug code
involved:
- `begin()`: 3 stalls in 17 runs of 100 rounds, always on the first warm-up.
- `reserve()` with explicit `BEGIN`: about 1 in 25 runs under `bun test`.

**Fix in @cslug/database.** Transactions, savepoints, `pin()` and session advisory locks use a second pool,
`transactionPool`, which is only ever used through `reserve()`, with explicit `BEGIN`/`SAVEPOINT`/`COMMIT`.
Plain queries never touch it, so they can't land on a reserved connection: 0 stalls in 60 runs. The
regression test "no stall while a fresh pool warms up…" repeats the triggering warm-up. Cost: up to
`pool.max` extra connections.

**To do:** report upstream to Bun with the standalone reproduction; drop the second pool once a fixed Bun is
the minimum.

## Bun.build fails on a second build inside `bun test` (found 2026-11-26)

Under `bun test` (Bun 1.3.14), once the test process has loaded a source file at runtime (here
`@cslug/validation`), a later `Bun.build` that bundles the same file fails with `Unexpected reading file`. The
first build in the process works, and `bun run` is unaffected (so `cslug build` and `cslug dev` are fine). The
vue tests run builds in a child process. **To do:** report upstream.
