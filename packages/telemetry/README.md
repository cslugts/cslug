# @cslug/telemetry

Records the traces and metrics cslug's packages report (requests, jobs, queries, AI runs) and exports them, with
logs, to any OpenTelemetry collector over OTLP/HTTP (Grafana, Honeycomb, Datadog, Jaeger…); serves `/metrics` for
Prometheus. No dependencies: the OTLP JSON encoding and the Prometheus text format are written over `fetch`.
`cslug add telemetry` installs it and lists `TelemetryProvider`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 23](../../guides/23-observability.md).
