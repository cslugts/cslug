# @cslug/testing: API

## `testApp(options?)`

| Option | Default | |
|---|---|---|
| `create` | `createApp()` from `bootstrap/app.ts` | Build the app |
| `config` | | Overrides by dotted path |
| `fakes` | `[]` | `'events'`, plus those packages register |
| `database` | `'transaction'` | `'truncate'` or `false` |
| `migrate` | `true` | Runs `database/migrations` once |
| `host` | host of `app.url` | |

Returns: `app`, `clock`, `resolve`, `swap`, `get/post/put/patch/delete(path)`, `beforeRequest(hook)`,
`db.count(table, where?)`, `db.find(table, id)`, `assertDatabaseHas/Missing(table, where)` (camelCase keys), and
each installed fake as `t.<name>`.

## Requests (`PendingRequest`, awaited to run)

Building: `header`, `headers({…})`, `withToken`, `json(data)`, `form(data)` (nested keys, CSRF, Referer).

Assertions (queued, run in order): `assertStatus`, `assertOk`, `assertCreated`, `assertNoContent`,
`assertNotFound`, `assertForbidden`, `assertUnauthorized`, `assertRedirect(to?)`, `assertJson(subset)`,
`assertProblem(status, code)`, `assertInvalid({ field: 'part of message' })` (JSON 422 or flashed),
`assertOldInput`, `assertSessionHas(key, value?)`, `assertSessionMissing`, `assertSee`, `assertDontSee`,
`assertHeader`, `assertCookie`. `follow()` makes the GET to the redirect location with the same cookies.

The awaited value is a `TestResponse`: `status`, `headers`, `body()`, `json()`, `session()`.

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
