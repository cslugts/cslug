# @cslug/vue

Vue as the server template language. Pages are `.vue` files rendered to HTML on the server; a component used
with `hydrate="…"` becomes an island, hydrated in the browser. A page without islands ships no JavaScript.

```ts
return view(ShowCircuit, { circuit, days })
```

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 08](../../guides/08-views-vue-scss.md).
