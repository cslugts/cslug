# Contributing

## Setup

```bash
bun install
docker compose up -d
bun run check
```

## Rules

- **Docs ship with code.** A change to a package updates `packages/<name>/docs/` in the same PR. If the code
  forces an API change, the matching guide in `guides/` changes in the same PR too.
- **Guides are the spec.** Tests are written from guide snippets first.
- **The package graph is enforced.** `scripts/package-graph.ts` mirrors `docs/packages.md`; `bun run check:graph`
  fails on undeclared imports, deep imports (`@cslug/x/src/...`), runtime `dependencies` or cycles. Changing
  the graph means changing `docs/packages.md` and the script together.
- **No third-party runtime dependencies.** Exceptions are listed in `docs/decisions.md` (D0) and declared as peers.
- **Conventions:** `docs/conventions.md`: kebab-case files named after their export, standard decorators
  (`@inject(A, B)`), typed errors only, `Clock` instead of `new Date()`.

## Pull requests

One milestone step per PR. CI must be green: lint, typecheck, package-graph check, tests (with Postgres and
Redis service containers).

## Releases

All packages share one version.

1. `bun run release version 0.1.0` → updates every `packages/*/package.json`.
2. Update `CHANGELOG.md`, commit, then `git tag v0.1.0 && git push --tags`.
3. The `Release` workflow publishes all packages in dependency order with npm provenance.

**First publish of a package.** npm trusted publishing is configured per package, and a package must exist
before it can be configured. For the first release, a maintainer publishes once from their machine
(`npm login`, then `bun scripts/release.ts publish`). Then, for each package on npmjs.com: Settings → Trusted
publishing → GitHub Actions, repository `cslugts/cslug`, workflow `release.yml`, environment `npm`. Every later
release runs from CI only.

Packages are published as TypeScript source (`exports` → `./src/index.ts`), since cslug targets Bun.
