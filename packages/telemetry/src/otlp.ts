import type { Attributes, LogLevel, MetricPoint, RecordedSpan } from '@cslug/core'

/** OTLP/HTTP JSON (the protocol every OpenTelemetry collector and most vendors accept on port 4318). */
type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
export type KeyValue = { key: string; value: AnyValue }

export function keyValues(attributes: Attributes = {}): KeyValue[] {
  const out: KeyValue[] = []
  for (const [key, v] of Object.entries(attributes)) {
    if (v === undefined) continue
    const value: AnyValue =
      typeof v === 'boolean'
        ? { boolValue: v }
        : typeof v === 'number'
          ? Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v }
          : { stringValue: String(v) }
    out.push({ key, value })
  }
  return out
}

const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString()
const KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const
const STATUS = { unset: 0, ok: 1, error: 2 } as const
const SEVERITY: Record<LogLevel, number> = { debug: 5, info: 9, warn: 13, error: 17 }
const SCOPE = { name: 'cslug' }

export function encodeSpans(resource: KeyValue[], spans: RecordedSpan[]) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [
          {
            scope: SCOPE,
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND[s.kind],
              startTimeUnixNano: nanos(s.start),
              endTimeUnixNano: nanos(s.endTime ?? s.start),
              attributes: keyValues(s.attributes),
              status: { code: STATUS[s.status], ...(s.error ? { message: s.error.message } : {}) },
              ...(s.error
                ? {
                    events: [
                      {
                        name: 'exception',
                        timeUnixNano: nanos(s.endTime ?? s.start),
                        attributes: keyValues({
                          'exception.type': s.error.name,
                          'exception.message': s.error.message,
                          'exception.stacktrace': s.error.stack,
                        }),
                      },
                    ],
                  }
                : {}),
            })),
          },
        ],
      },
    ],
  }
}

/** Counters and histograms are cumulative since `start`; OTLP histogram buckets are per bucket, not cumulative. */
export function encodeMetrics(resource: KeyValue[], points: MetricPoint[], start: number, now: number) {
  const byName = new Map<string, MetricPoint[]>()
  for (const p of points) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  const base = (p: MetricPoint) => ({
    attributes: keyValues(p.attributes),
    startTimeUnixNano: nanos(start),
    timeUnixNano: nanos(now),
  })
  const metrics = [...byName].map(([name, list]) => {
    const first = list[0] as MetricPoint
    if (first.type === 'counter')
      return {
        name,
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: list.map((p) => ({ ...base(p), asDouble: (p as { value: number }).value })),
        },
      }
    if (first.type === 'gauge')
      return {
        name,
        gauge: {
          dataPoints: list
            .filter((p) => Number.isFinite((p as { value: number }).value))
            .map((p) => ({ ...base(p), timeUnixNano: nanos(now), asDouble: (p as { value: number }).value })),
        },
      }
    return {
      name,
      ...(/(duration|age)$/.test(name) ? { unit: 's' } : {}),
      histogram: {
        aggregationTemporality: 2,
        dataPoints: list.map((p) => {
          const h = p as Extract<MetricPoint, { type: 'histogram' }>
          return {
            ...base(p),
            count: String(h.count),
            sum: h.sum,
            min: h.min,
            max: h.max,
            explicitBounds: h.buckets,
            bucketCounts: h.counts.map((c, i) => String(c - (i ? (h.counts[i - 1] as number) : 0))),
          }
        }),
      },
    }
  })
  return { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope: SCOPE, metrics }] }] }
}

/** Log lines as the logger writes them (JSON); trace and span ids become the record's own fields. */
export function encodeLogs(resource: KeyValue[], lines: string[]) {
  const records = lines.flatMap((line) => {
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line)
    } catch {
      return []
    }
    const { time, level, msg, traceId, spanId, ...rest } = entry
    const attributes: Attributes = {}
    for (const [k, v] of Object.entries(rest))
      attributes[k] = typeof v === 'object' && v !== null ? JSON.stringify(v) : (v as Attributes[string])
    const at = typeof time === 'string' ? Date.parse(time) : Date.now()
    const severity = SEVERITY[level as LogLevel] ?? 9
    return [
      {
        timeUnixNano: nanos(at),
        severityNumber: severity,
        severityText: String(level ?? 'info').toUpperCase(),
        body: { stringValue: String(msg ?? '') },
        attributes: keyValues(attributes),
        ...(typeof traceId === 'string' ? { traceId } : {}),
        ...(typeof spanId === 'string' ? { spanId } : {}),
      },
    ]
  })
  return { resourceLogs: [{ resource: { attributes: resource }, scopeLogs: [{ scope: SCOPE, logRecords: records }] }] }
}

export type OtlpOptions = {
  /** The collector's base URL: `http://localhost:4318` (`/v1/traces`, `/v1/metrics`, `/v1/logs` are added). */
  endpoint: string
  /** Sent with every export: an API key (`{ 'x-honeycomb-team': … }`, `{ authorization: 'Bearer …' }`). */
  headers?: Record<string, string>
  /** Spans and logs are sent in batches of this many (default 512) or every `flushMs` (default 5000). */
  batchSize?: number
  flushMs?: number
  /** Metrics are sent every `intervalMs` (default 60000). */
  intervalMs?: number
  /** Per export request (default 10000). */
  timeoutMs?: number
  /** Most spans and log lines kept while the collector is unreachable; the oldest are dropped (default 4096). */
  maxQueue?: number
}

/**
 * Batches spans and log lines and sends them, and metrics on an interval, to an OTLP/HTTP collector. Exports never
 * throw into the app: a failure is written once a minute to stderr (not the logger, which may export too).
 */
export class OtlpExporter {
  private spans: RecordedSpan[] = []
  private lines: string[] = []
  private timers: Timer[] = []
  private lastWarning = 0
  private readonly started = Date.now()
  /** Exports in flight (awaited by `flush()`). */
  private pending = new Set<Promise<void>>()

  constructor(
    readonly options: OtlpOptions,
    private readonly resource: KeyValue[],
    private readonly collect?: () => Promise<MetricPoint[]>,
  ) {}

  start(): void {
    const flush = setInterval(() => void this.send(), this.options.flushMs ?? 5000)
    flush.unref()
    this.timers.push(flush)
    if (this.collect) {
      const metrics = setInterval(() => void this.sendMetrics(), this.options.intervalMs ?? 60_000)
      metrics.unref()
      this.timers.push(metrics)
    }
  }

  span(span: RecordedSpan): void {
    this.enqueue(this.spans, span)
  }

  log(line: string): void {
    this.enqueue(this.lines, line)
  }

  private enqueue<T>(queue: T[], item: T): void {
    queue.push(item)
    if (queue.length > (this.options.maxQueue ?? 4096)) queue.shift()
    if (queue.length >= (this.options.batchSize ?? 512)) void this.send()
  }

  /** Send what is queued (and wait for exports in flight). */
  async flush(): Promise<void> {
    await this.send()
    await Promise.all(this.pending)
  }

  /** Stop the timers, send the queues and the metrics one last time. */
  async shutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    await Promise.all([this.flush(), this.sendMetrics()])
    await Promise.all(this.pending)
  }

  private send(): Promise<void> {
    const spans = this.spans.splice(0)
    const lines = this.lines.splice(0)
    const sends: Promise<void>[] = []
    if (spans.length) sends.push(this.post('/v1/traces', encodeSpans(this.resource, spans)))
    if (lines.length) sends.push(this.post('/v1/logs', encodeLogs(this.resource, lines)))
    return Promise.all(sends).then(() => {})
  }

  private async sendMetrics(): Promise<void> {
    if (!this.collect) return
    const points = await this.collect()
    if (points.length) await this.post('/v1/metrics', encodeMetrics(this.resource, points, this.started, Date.now()))
  }

  private post(path: string, body: unknown): Promise<void> {
    const url = `${this.options.endpoint.replace(/\/+$/, '')}${path}`
    const request = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.options.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    })
      .then(async (res) => {
        if (!res.ok) this.warn(`${url} answered ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
      })
      .catch((error: unknown) => this.warn(`${url}: ${error instanceof Error ? error.message : String(error)}`))
    this.pending.add(request)
    void request.finally(() => this.pending.delete(request))
    return request
  }

  private warn(message: string): void {
    if (Date.now() - this.lastWarning < 60_000) return
    this.lastWarning = Date.now()
    process.stderr.write(
      `${JSON.stringify({ time: new Date().toISOString(), level: 'warn', msg: 'telemetry.export_failed', error: message })}\n`,
    )
  }
}
