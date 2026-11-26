# AGENTS.md — starter kit

Conventions for AI coding agents working in this app. Framework docs: `node_modules/@cslug/*/docs/` (or `../../docs`, `../../guides` in this repo).

- **Layout by type:** `app/controllers/`, `app/validators/`, `app/repositories/`, `app/tables/`, … File name = class name in kebab-case (`TodoRepository` → `todo-repository.ts`). No dots in file names except `.test.ts`.
- **DI:** standard decorators. `@inject(A, B)` lists the constructor's dependencies in order; `cslug typecheck` fails if they don't match.
- **Views** are Vue SFCs in `resources/views/`, rendered on the server. A component in `resources/components/` becomes an island only where it is used with `hydrate="…"`; its props must be `Serialized<T>`, passed with `serialize(row)`.
- **Validation:** `await request.validate(SomeValidator)`; never read `request.input()` for writes.
- **Authorization:** `await auth.authorize(Policy, 'ability', row)` before touching another user's data.
- **SQL:** builder for single-table queries, the `sql` tag for joins. Never build SQL strings.
- **Time:** inject `Clock`; never call `new Date()` in app code.
- **Before finishing:** `cslug typecheck && bun test`.
