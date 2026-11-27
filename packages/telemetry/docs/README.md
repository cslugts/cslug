# @cslug/telemetry

Without this package, core binds a `Tracer` and `Metrics` that do nothing: http, queue, database and ai call them
anyway, at almost no cost. `TelemetryProvider` binds ones that record, then:

- exports spans, metrics and (opt in) log lines to an OTLP/HTTP collector, in batches, flushed at shutdown;
- serves `GET /metrics` in Prometheus format (loopback only, unless a token or an allow list says otherwise).

List it **first** in `bootstrap/providers.ts`: providers shut down in reverse order, so it flushes last.

## Configuration

```ts
// config/telemetry.ts
export default defineConfig({
  serviceName: 'bookings', // default: app.name
  sampleRate: 0.2, // a fifth of new traces; a continued trace follows its caller; failed spans always go
  otlp: {
    endpoint: 'https://otlp.example.com', // default: OTEL_EXPORTER_OTLP_ENDPOINT; none, no export
    headers: { authorization: `Bearer ${env.OTLP_TOKEN}` }, // default: OTEL_EXPORTER_OTLP_HEADERS
    logs: 'warn', // send log lines from this level (default: false)
    // traces: true, metrics: true, intervalMs: 60_000, flushMs: 5_000, batchSize: 512, timeoutMs: 10_000
  },
  metrics: { token: env.METRICS_TOKEN, allow: ['10.0.0.0/8'] }, // or false: no /metrics
})
```

Resource attributes on everything exported: `service.name`, `service.version`, `service.instance.id`
(host and pid), `deployment.environment.name` (`app.env`), `cslug.role` (web, worker, scheduler).

## What is recorded

| Source | Spans | Metrics |
|---|---|---|
| http | `GET /bookings/:id` (server; continues an incoming `traceparent`) | `http.server.request.duration` |
| queue | `publish <job>` → `process <job>` (one trace from the request to its jobs) | `messaging.process.duration` (by outcome), `cslug.queue.waiting`, `cslug.queue.oldest_age` |
| database | `SELECT bookings` (operation and table, never values) | `db.client.operation.duration` |
| ai | `invoke_agent`, `chat <model>` (tokens), `execute_tool` | |
| process | | `process.memory.usage`, `process.uptime` |

Your own: inject `Tracer` and `Metrics` (from `@cslug/core`, so the code works without this package):

```ts
@inject(Tracer, Metrics)
export class PayoutService {
  constructor(private tracer: Tracer, private metrics: Metrics) {}

  release(booking: Booking) {
    return this.tracer.span('payout.release', { attributes: { 'booking.id': booking.id } }, async () => {
      await this.provider.transfer(booking)
      this.metrics.increment('payouts.released', { currency: booking.currency })
    })
  }
}
```

## Failures

An export never throws into the app. When the collector is unreachable, spans and lines wait in a bounded queue
(the oldest are dropped past `maxQueue`), and a warning goes to stderr at most once a minute.
