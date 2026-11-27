# AGENTS.md

Instructions for AI coding agents working in this repository.

## What this is

cslug: a Laravel-flavoured framework for Bun, published as `@cslug/*` packages (`packages/*`). The spec is in
`docs/` and `guides/`; `apps/starter-kit` is the reference app and acceptance test. The current milestone is in
`docs/implementation-plan.md` (status table at the top).

## Commands

```bash
bun install
docker compose up -d           # postgres :5432, redis :6379, mailpit :1025/:8025
bun run check                  # lint + typecheck + package-graph check + tests — must pass before finishing
bun test packages/<name>       # one package
bun run check:graph            # dependency rules
```

## Rules

1. **Read the guide first.** Each package's behaviour is specified in `guides/` (see `guides/README.md`). Write
   tests from the guide snippets, then implement.
2. **Docs with code.** Update `packages/<name>/docs/README.md` + `api.md` in the same change. If the API must
   differ from a guide, update the guide too and say why in the PR.
3. **Package graph** (`docs/packages.md`, enforced by `scripts/check-graph.ts`): import only allowed `@cslug/*`
   packages, never deep paths, no third-party runtime dependencies.
4. **Conventions** (`docs/conventions.md`):
   - kebab-case files named after their export
   - standard decorators: `@inject(A, B)`
   - typed errors only
   - `Clock` for time
   - money as bigint minor units
   - UUIDv7 ids
5. **Don't reopen settled decisions** (`docs/decisions.md`, `docs/open-questions.md` § Decided). Propose changes
   explicitly instead.
6. Mind the size budgets in `docs/packages.md`: guides, not hard limits (report the size; simplify a package far
   over its budget).
