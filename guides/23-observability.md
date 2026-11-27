# 23. Observability

What a running app tells you: logs, traces and metrics. Logs work out of the box; traces and metrics need
`@cslug/telemetry` (`cslug add telemetry`).

## Logs

`config/log.ts` sets the level, the format and the destinations:

```ts
export default defineConfig({
  level: env.LOG_LEVEL, // debug, info, warn, error
  format: env.LOG_FORMAT ?? (env.APP_ENV === 'production' ? 'json' : 'pretty'),
  targets: [
    { type: 'stdout' },
    { type: 'file', path: 'storage/logs/app-{date}.log', keep: 14, format: 'json', level: 'warn' },
  ],
})
```

Every line carries what the context knows: `requestId`, `userId`, the process `role`, and in a job its `jobId` and
`originRequestId` (the request that started the work, kept through jobs that dispatch jobs). Search one request id
and you find its jobs. With telemetry, lines also carry `traceId` and `spanId`. Keys like `password`, `token` or
`authorization` are redacted at any depth.

## Traces

A trace is a request and everything it caused, as a tree of timed spans:

```
GET /bookings/:id/confirm          212 ms
├─ SELECT bookings                   3 ms
├─ UPDATE bookings                   4 ms
├─ publish payments.capture          1 ms
│  └─ process payments.capture     180 ms   (in the worker, seconds later)
│     ├─ SELECT bookings             2 ms
│     └─ chat claude-sonnet-5-5    150 ms   (input and output tokens)
└─ INSERT cslug_notifications        2 ms
```

http, queue, database and ai record these spans through core's `Tracer`. A request that arrives with a W3C
`traceparent` header (from a load balancer, another service, a browser SDK) continues that trace. Queries are named by
operation and table; their values never leave the app.

```ts
// config/telemetry.ts
export default defineConfig({
  sampleRate: 0.2, // a fifth of new traces; failed requests are always exported
  otlp: { logs: 'warn' }, // OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS
})
```

Any OpenTelemetry collector or vendor that accepts OTLP/HTTP works: run the OpenTelemetry Collector, Grafana Alloy or
Jaeger next to the app, or point the endpoint at a hosted service with its API key in the headers.

Your own spans and metrics use the same contracts (from `@cslug/core`, so the code runs with or without telemetry):

```ts
await tracer.span('payout.release', { attributes: { 'booking.id': booking.id } }, async () => {
  await provider.transfer(booking)
  metrics.increment('payouts.released', { currency: booking.currency })
})
```

## Metrics

`GET /metrics` answers in Prometheus format: request durations by route and status, job durations by outcome,
waiting jobs and the oldest one's age per queue, query durations, memory and uptime. It is closed to the internet
by default (loopback only); give your scraper a token or an address range:

```ts
metrics: { token: env.METRICS_TOKEN, allow: ['10.0.0.0/8'] }
```

The same numbers are exported over OTLP every minute when an endpoint is set.

## Health

`/health/live` and `/health/ready` (guide 21) stay the checks for a load balancer; metrics and traces are for people.
