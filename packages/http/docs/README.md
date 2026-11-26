# @cslug/http

Routing, controllers, request validation, responses, error rendering, sessions, CSRF, form errors with old
input, throttling and locale detection, on `Bun.serve`.

```ts
// routes/web.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/:locale', as: 'public' }, (r) => {
    r.get('/circuits/:slug', [CircuitController, 'show']).name('circuits.show')
  })
  r.resource('operators', OperatorController).only(['index', 'show'])
  r.group({ domain: 'api.albastr.com', prefix: '/v1' }, (r) => { … })
})

// a controller action
async store({ request }: HttpContext) {
  const data = await request.validate(StoreTripRequestValidator)   // typed; 422 on failure
  return created(await this.trips.open(data))
}
```

- Full reference: [api.md](./api.md)
- Guides: [05 Routing & middleware](../../../guides/05-routing-and-middleware.md), [06 Controllers](../../../guides/06-controllers.md), [07 Validation](../../../guides/07-validation.md)
