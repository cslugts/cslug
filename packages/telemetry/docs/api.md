# @cslug/telemetry API

| | |
|---|---|
| `TelemetryProvider` | Binds a recording `Tracer` (`BasicTracer`, sampled) and `Metrics` (`BasicMetrics`), the exporter, `/metrics` |
| `Telemetry` | `metrics` (`collect()`), `exporter`, `flush()` |
| `TelemetryConfig` | `serviceName`, `serviceVersion`, `sampleRate`, `otlp` (or `false`), `metrics` (or `false`) |
| `OtlpExporter` | `span()`, `log()`, `start()`, `flush()`, `shutdown()`; OTLP/HTTP JSON to `<endpoint>/v1/traces`, `/v1/metrics`, `/v1/logs` |
| `encodeSpans`, `encodeMetrics`, `encodeLogs`, `keyValues` | The OTLP JSON bodies |
| `prometheusText(points)`, `prometheusName(name)` | Prometheus text format 0.0.4: `.` → `_`, counters `_total`, durations and ages `_seconds` |
| `ipAllowed(ip, list)`, `bearerMatches(header, token)` | `/metrics` access: addresses and IPv4 CIDR ranges; constant-time token check |

Metrics are cumulative (counters and histograms since the process started), as Prometheus expects and OTLP allows
(`aggregationTemporality: cumulative`).
