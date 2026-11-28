# create-cslug

`bun create cslug <dir>` runs this package's `create-cslug` binary. It writes a new app into `<dir>` (which must be
missing or empty), runs `bun install` and `git init`, and prints the next steps.

## Presets

| Preset | Packages | Adds |
|---|---|---|
| `--api` | core, validation, http, database, redis, cli · dev: testing | `routes/api.ts` with `/api/v1/hello`, config, a feature test |
| `--web` (default) | api + vue, auth · `vue`, `sass`, `vue-tsc` | Home page, register / log in / log out, a dashboard behind `auth()`, the `users` table and factory, layout and styles, auth tests |
| `--full` | web + queue, mail, storage | Worker and scheduler in `cslug.config.ts`, `routes/schedule.ts`, mail config and a queued `WelcomeMail` on a Vue template, storage config, Mailpit in docker-compose |
| `--tailwind` | `tailwindcss`, `bun-plugin-tailwind` | `resources/styles/tailwind.css`, imported by `resources/client.ts`; `assets.tailwind: true` |

Every `@cslug/*` package is pinned to the scaffolder's own version: all packages of a release share one version.

**Always the latest release.** `bun create cslug` can run a `create-cslug` that Bun cached long ago, which would pin
the new app to that old release. So `bin.ts` first asks the registry (`npm_config_registry`, else npmjs.org;
3 s timeout) for `create-cslug/latest` and, when it is newer, runs `bun x create-cslug@<latest>` with the same
arguments (`CSLUG_NO_UPDATE_CHECK=1` for the child, so it checks once). Offline or on a registry error it goes on
with its own version. `--no-update-check` (or `CSLUG_NO_UPDATE_CHECK=1`) skips the check. `isNewer`,
`latestRelease` and `newerRelease` are exported.

## What is written

- `.env` from `.env.example` with a fresh `APP_KEY`; `.env.test` (used by `bun test`) with its own key.
- The app name comes from the folder: `my-app` → package `my-app`, title "My App" in `config/app.ts` and the
  translations, database `my_app` (and `my_app_test`).
- `bunfig.toml` (web, full) preloads `@cslug/vue/register`, so tests can import `.vue` files and mailables directly.

## Templates

`templates/<layer>/` holds literal files: `api`, then `web`, then `full` (a later layer replaces a file of the same
path), then `tailwind`. `{{name}}`, `{{title}}`, `{{db}}`, `{{tailwind}}`, `{{styles}}` and `{{testKey}}` are
filled in; a leading `_` in a file name becomes a dot (npm does not publish `.gitignore`), and a `.tpl` suffix is
dropped (so template tests do not run in the cslug repository).

In the repository, `bun run check:create` scaffolds each preset, links it to the local packages, then typechecks
it, builds its assets and runs its tests.
