# AGENTS.md

A cslug app (Bun + TypeScript + PostgreSQL + Redis). The framework's guides are at
https://github.com/cslugts/cslug/tree/main/guides.

- `bun test` must pass; `bun run typecheck` too.
- Files are kebab-case and named after their export; classes are wired with `@inject(A, B)`.
- Time comes from `Clock`, money is integer minor units, ids are UUIDv7.

Run `cslug agents:sync` to add (and later refresh) the generated sections: the installed packages and their docs,
the rules, the folders, the commands, this app's routes and tables. Edit anything outside its `cslug:begin` /
`cslug:end` markers; it is kept.
