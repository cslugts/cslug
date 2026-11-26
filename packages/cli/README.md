# @cslug/cli

The `cslug` command. It runs built-in commands, the commands your installed packages contribute (`migrate`
with @cslug/database, `serve` with @cslug/http, …) and your own in `app/commands/`.

```bash
cslug list
cslug make:controller admin/Claim --resource
cslug migrate --force && cslug start
```

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 20](../../guides/20-cli.md).
