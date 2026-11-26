# @cslug/testing

`testApp()` builds and starts your app once per test file and isolates every test:

- **database**: each test runs in a transaction that is rolled back (`database: 'truncate'` for real commits)
- **cookies**: a fresh browser-like cookie jar per test
- **clock**: a new `FakeClock` per test (`t.clock.travelTo()`, `advance()`)
- **swaps and fakes**: reset after each test

```ts
import { testApp } from '@cslug/testing'

const t = testApp({ fakes: ['events'] })

test('adding a todo', async () => {
  await t.post('/todos').form({ title: 'Buy bread' }).assertRedirect().assertSessionHas('success').follow().assertSee('Buy bread')
  await t.assertDatabaseHas('todos', { title: 'Buy bread' })
  t.events.assertEmitted(TodoCreated)
})
```

Requests go straight to the HTTP kernel (no port). `.form()` adds the CSRF token and a Referer as a browser
would, so failed validation redirects back and `assertInvalid()` / `assertOldInput()` read the flashed errors.

More assertions arrive with their packages: `actingAs` (auth), `assertQueued` (queue), `assertView` /
`assertIsland` (vue), `assertSent` (mail). See [api.md](api.md).
