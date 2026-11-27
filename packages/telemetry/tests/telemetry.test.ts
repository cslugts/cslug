import { afterAll, describe, expect, test } from 'bun:test'
import { Application, BasicMetrics, Logger, Tracer } from '@cslug/core'
import { HttpKernel, HttpProvider, Router } from '@cslug/http'
import { bearerMatches, ipAllowed, prometheusName, prometheusText, Telemetry, TelemetryProvider } from '../src'

// biome-ignore lint/suspicious/noExplicitAny: walking OTLP JSON payloads
type Json = any

/** A stand-in OpenTelemetry collector: records what is posted to /v1/*. */
const received: { path: string; body: Record<string, unknown[]> }[] = []
const collector = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push({ path: new URL(req.url).pathname, body: await req.json() })
    return new Response('{}')
  },
})
afterAll(() => collector.stop(true))

const kv = (attrs: { key: string; value: Record<string, unknown> }[] = [], key: string) =>
  Object.values(attrs.find((a) => a.key === key)?.value ?? {})[0]

async function app(telemetry: Record<string, unknown>) {
  const app = new Application({
    root: '/nonexistent-cslug-test-root',
    configs: {
      app: { name: 'Demo', env: 'test', url: 'https://example.test', key: 'k'.repeat(32) },
      log: { write: () => {} },
      telemetry,
    },
  })
  app.useProviders([TelemetryProvider, HttpProvider])
  await app.start()
  app.resolve(Router).load((r) => {
    r.get('/bookings/:id', ({ params }) => {
      app.resolve(Logger).info('showing booking', { id: params.id })
      return { id: params.id }
    })
    r.get('/broken', () => {
      throw new Error('db down')
    })
  })
  const kernel = app.resolve(HttpKernel).compile()
  const call = (path: string, init: RequestInit = {}, ip = '127.0.0.1') =>
    kernel.handle(new Request(new URL(path, 'http://example.test'), init), { ip })
  return { app, call }
}

describe('OTLP export', () => {
  test('traces, logs (linked to the trace) and metrics reach the collector, with the resource', async () => {
    received.length = 0
    const { app: a, call } = await app({
      otlp: { endpoint: `http://localhost:${collector.port}`, logs: true, headers: { 'x-api-key': 'k1' } },
    })
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    await call('/bookings/b1', { headers: { traceparent: parent } })
    await a.resolve(Telemetry).flush()

    const traces = received.find((r) => r.path === '/v1/traces')?.body as Json
    const resource = traces.resourceSpans[0].resource.attributes
    expect(kv(resource, 'service.name')).toBe('Demo')
    expect(kv(resource, 'deployment.environment.name')).toBe('test')
    const span = traces.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span).toMatchObject({
      name: 'GET /bookings/:id',
      kind: 2,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      status: { code: 1 },
    })
    expect(kv(span.attributes, 'http.response.status_code')).toBe('200')
    expect(BigInt(span.endTimeUnixNano)).toBeGreaterThan(BigInt(span.startTimeUnixNano))

    const logs = received.find((r) => r.path === '/v1/logs')?.body as Json
    const records = logs.resourceLogs[0].scopeLogs[0].logRecords
    const line = records.find((r: Json) => r.body.stringValue === 'showing booking')
    expect(line).toMatchObject({ severityNumber: 9, severityText: 'INFO', traceId: span.traceId, spanId: span.spanId })
    expect(kv(line.attributes, 'id')).toBe('b1')

    await a.shutdown() // sends the metrics one last time
    const metrics = received.find((r) => r.path === '/v1/metrics')?.body as Json
    const list = metrics.resourceMetrics[0].scopeMetrics[0].metrics
    const duration = list.find((m: Json) => m.name === 'http.server.request.duration')
    expect(duration.unit).toBe('s')
    const point = duration.histogram.dataPoints[0]
    expect(point.count).toBe('1')
    expect(point.bucketCounts.reduce((n: number, c: string) => n + Number(c), 0)).toBe(1) // per bucket, not cumulative
    expect(list.some((m: Json) => m.name === 'process.memory.usage' && m.gauge)).toBe(true)
  })

  test('sampling: an unsampled trace is not exported, a failed request always is', async () => {
    received.length = 0
    const { app: a, call } = await app({ sampleRate: 0, otlp: { endpoint: `http://localhost:${collector.port}` } })
    await call('/bookings/b1')
    await call('/broken')
    await a.resolve(Telemetry).flush()
    const spans = received
      .filter((r) => r.path === '/v1/traces')
      .flatMap((r: Json) => r.body.resourceSpans[0].scopeSpans[0].spans)
    expect(spans.map((s: Json) => s.name)).toEqual(['GET /broken'])
    expect(spans[0].status).toMatchObject({ code: 2, message: 'db down' })
    expect(spans[0].events[0].name).toBe('exception')
    await a.shutdown()
  })

  test('no endpoint: spans are recorded (ids in logs) but nothing is sent; the collector being down never throws', async () => {
    received.length = 0
    const { app: a, call } = await app({})
    expect(a.resolve(Tracer).enabled).toBe(true)
    expect((await call('/bookings/b1')).status).toBe(200)
    await a.shutdown()
    expect(received).toHaveLength(0)

    const { app: b, call: callB } = await app({ otlp: { endpoint: 'http://127.0.0.1:9' } })
    expect((await callB('/bookings/b1')).status).toBe(200)
    await b.shutdown()
  })
})

describe('/metrics', () => {
  test('Prometheus text; loopback only by default; a bearer token or an allow list opens it', async () => {
    const { app: a, call } = await app({ otlp: false })
    await call('/bookings/b1')
    const res = await call('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain; version=0.0.4')
    const text = await res.text()
    expect(text).toContain('# TYPE http_server_request_duration_seconds histogram')
    expect(text).toMatch(/http_server_request_duration_seconds_count\{.*http_route="\/bookings\/:id".*\} 1/)
    expect((await call('/metrics', {}, '203.0.113.7')).status).toBe(403)
    await a.shutdown()

    const { app: b, call: callB } = await app({ otlp: false, metrics: { token: 's3cret', allow: ['10.0.0.0/8'] } })
    expect((await callB('/metrics', {}, '127.0.0.1')).status).toBe(403) // a token replaces the loopback default
    expect((await callB('/metrics', { headers: { authorization: 'Bearer s3cret' } }, '203.0.113.7')).status).toBe(200)
    expect((await callB('/metrics', { headers: { authorization: 'Bearer wrong' } }, '203.0.113.7')).status).toBe(403)
    expect((await callB('/metrics', {}, '10.20.30.40')).status).toBe(200)
    await b.shutdown()
  })

  test('rendering: names, counters, gauges, histograms, label escaping', async () => {
    const m = new BasicMetrics([0.1, 1])
    m.increment('cslug.mail.sent', { transport: 'smtp' }, 2)
    m.record('db.client.operation.duration', 0.5, { 'db.operation.name': 'SELECT' })
    m.observe('cslug.queue.waiting', () => 3, { queue: 'say "hi"\n' })
    const text = prometheusText(await m.collect())
    expect(prometheusName('cslug.queue.oldest_age')).toBe('cslug_queue_oldest_age_seconds')
    expect(text).toContain('# TYPE cslug_mail_sent_total counter\ncslug_mail_sent_total{transport="smtp"} 2')
    expect(text).toContain('db_client_operation_duration_seconds_bucket{db_operation_name="SELECT",le="0.1"} 0')
    expect(text).toContain('db_client_operation_duration_seconds_bucket{db_operation_name="SELECT",le="1"} 1')
    expect(text).toContain('db_client_operation_duration_seconds_bucket{db_operation_name="SELECT",le="+Inf"} 1')
    expect(text).toContain('db_client_operation_duration_seconds_sum{db_operation_name="SELECT"} 0.5')
    expect(text).toContain('cslug_queue_waiting{queue="say \\"hi\\"\\n"} 3')
  })

  test('access helpers', () => {
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(ipAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false)
    expect(ipAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true)
    expect(ipAllowed('::1', ['127.0.0.1', '::1'])).toBe(true)
    expect(ipAllowed('192.168.1.200', ['192.168.1.128/25'])).toBe(true)
    expect(ipAllowed('192.168.1.12', ['192.168.1.128/25'])).toBe(false)
    expect(ipAllowed(undefined, ['0.0.0.0/0'])).toBe(false)
    expect(bearerMatches('Bearer abc', 'abc')).toBe(true)
    expect(bearerMatches('bearer abcd', 'abc')).toBe(false)
    expect(bearerMatches(null, 'abc')).toBe(false)
  })
})
