# @cslug/testing: API

## `testApp(options?)`

| Option | Default | |
|---|---|---|
| `create` | `createApp()` from `bootstrap/app.ts` | Build the app |
| `config` | | Overrides by dotted path |
| `fakes` | `[]` | `'events'`, `'queue'`, `'mail'` (loaded from their package). A fake listed here is typed as present on `t` |
| `database` | `'transaction'` | `'truncate'` or `false` |
| `migrate` | `true` | Runs `database/migrations` once |
| `host` | host of `app.url` | |

Returns: `app`, `clock`, `resolve`, `swap`, `actingAs(user)` (for every request of the test), `get/post/put/patch/delete(path)`, `beforeRequest(hook)`,
`db.count(table, where?)`, `db.find(table, id)`, `assertDatabaseHas/Missing(table, where)` (camelCase keys; values
or `@cslug/database` operators: `{ remindedAt: notNull() }`), each installed fake as `t.<name>`, and:

- `auth.check()` / `auth.user()`: who the session says is signed in after the last request (@cslug/auth).
- `tokens.create(user, { abilities?, name?, expiresIn? })` → `{ plainText }` (@cslug/auth).
- `schedule.runDue()`: run the schedule entries due at `t.clock`'s time (@cslug/queue's ScheduleProvider).

## Requests (`PendingRequest`, awaited to run)

Building: `header`, `headers({…})`, `withToken`, `actingAs(user)` (signed in through the session, with
@cslug/auth), `json(data)` (writes carry the session's CSRF token in `X-CSRF-Token`, as an island's `useForm`
does), `form(data)` (nested keys, CSRF, Referer).

Assertions (queued, run in order): `assertStatus`, `assertOk`, `assertCreated`, `assertNoContent`,
`assertNotFound`, `assertForbidden`, `assertUnauthorized`, `assertRedirect(to?)`, `assertJson(subset)`,
`assertProblem(status, code)`, `assertInvalid({ field: 'part of message' })` (JSON 422 or flashed),
`assertOldInput`, `assertSessionHas(key, value?)`, `assertSessionMissing`, `assertSee`, `assertDontSee`,
`assertHeader`, `assertCookie`, `assertView(View, (props) => …)` (the page `view()` rendered for this request,
@cslug/vue), `assertIsland(name, props?)` (an island marker in the HTML; `name` with or without its folder,
`props` a deep subset). `follow()` makes the GET to the redirect location with the same cookies.

The awaited value is a `TestResponse`: `status`, `headers`, `body()`, `json()`, `session()`, `views`, `islands()`.

## Fakes

`EventFake` (`'events'`): `emitted`, `of(Event)`, `assertEmitted(Event, predicate?)`, `assertNotEmitted`,
`assertNothingEmitted`.

Packages add theirs:

```ts
registerFake('queue', (app) => { const fake = new QueueFake(); app.swap(Queue, fake); return fake })
declare module '@cslug/testing' { interface TestFakes { queue: QueueFake } }
```

## Database isolation

`Database.pin()` (from `@cslug/database`) holds one transaction for the test; queries without their own
transaction use it, and `transaction()` calls become savepoints whose `afterCommit` hooks run on release.
