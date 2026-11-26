# create-cslug

Create a [cslug](https://github.com/cslugts/cslug) app:

```bash
bun create cslug my-app            # pages, Vue islands and auth (--web, the default)
bun create cslug my-api --api      # a JSON API: no views, no Vue
bun create cslug my-app --full     # web + queue, scheduler, mail and storage
bun create cslug my-app --tailwind # add Tailwind CSS (with --web or --full)
```

`--no-install` skips `bun install`, `--no-git` skips `git init`. Docs: [docs/README.md](docs/README.md),
[guide 01](../../guides/01-getting-started.md).
