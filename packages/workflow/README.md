# @cslug/workflow

Durable workflows for cslug apps: an `@inject()` class whose `run(ctx, input)` is journaled step by step in
PostgreSQL and woken up by queue jobs. Steps run once (retried with backoff, without holding a worker), sleeps last
days, runs wait for events and signals, and a run picks up where it stopped after a deploy or a crash. No server
besides the app's Postgres and Redis. `cslug add workflow` installs it and lists `WorkflowProvider`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 25](../../guides/25-workflows.md).
