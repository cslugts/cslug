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

## Intermittent hang: 200 concurrent transactions in CI (seen 2026-11-26)

`packages/database/tests/database.test.ts` › "the context survives queries and transactions" timed out once (5 s) in
CI on PR #16, and its `afterAll` (drop database) hung too. It passed on re-run. Locally it never failed in 37
runs, including 25 pinned to one CPU. Suspect: `Bun.sql` pool (max 8) under 200 concurrent `begin` + savepoints
on a slow runner. **To do:** if it recurs, capture `pg_stat_activity` on timeout and try to reproduce with a
standalone `Bun.sql` script; report upstream if confirmed.
