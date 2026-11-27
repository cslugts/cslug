import { currentContext, runInContext } from './context'

/** Span and metric attributes (OpenTelemetry semantic-convention names where they exist). */
export type Attributes = Record<string, string | number | boolean | undefined>
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer'

/** One timed operation of a trace. */
export interface Span {
  readonly name: string
  /** Rename once more is known (`GET` → `GET /bookings/:id` after routing). */
  updateName(name: string): void
  readonly traceId: string
  readonly spanId: string
  /** W3C trace context of this span, for a child elsewhere (an HTTP header, a job envelope). */
  readonly traceparent: string
  setAttributes(attributes: Attributes): void
  /** Mark the span failed and keep the error (name, message, stack). */
  recordError(error: unknown): void
  end(): void
}

export type SpanOptions = {
  kind?: SpanKind
  attributes?: Attributes
  /** The parent's `traceparent` (an incoming header, a job's origin); default: the span the context is in. */
  parent?: string
}

const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

/** `00-<trace id>-<span id>-<flags>`, or undefined when malformed (W3C Trace Context). */
export function parseTraceparent(
  value: string | undefined,
): { traceId: string; spanId: string; sampled: boolean } | undefined {
  const m = value ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value.trim()) : null
  if (!m || /^0+$/.test(m[1] as string) || /^0+$/.test(m[2] as string)) return undefined
  return { traceId: m[1] as string, spanId: m[2] as string, sampled: (Number.parseInt(m[3] as string, 16) & 1) === 1 }
}

const NOOP_SPAN: Span = {
  name: '',
  updateName() {},
  traceId: '',
  spanId: '',
  traceparent: '',
  setAttributes() {},
  recordError() {},
  end() {},
}

/**
 * Traces. Packages call `tracer.span(name, options, fn)` around their work; core binds a no-op `Tracer` (nothing is
 * recorded, `fn` just runs), and `@cslug/telemetry` binds one that records and exports. Inside a span the context
 * carries `traceId`, `spanId` and `traceparent`, so log lines and dispatched jobs follow the trace.
 */
export abstract class Tracer {
  /** False for the no-op tracer: instrumentation can skip building attributes. */
  abstract readonly enabled: boolean
  /** Start a span (`span()` is usually what you want: it ends it and handles the context). */
  abstract startSpan(name: string, options?: SpanOptions): Span

  /** The span the current context is in. */
  current(): Span | undefined {
    return currentContext()?.span as Span | undefined
  }

  /** Run `fn` in a new span: errors are recorded (and rethrown), the span always ends. */
  async span<T>(name: string, options: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
    if (!this.enabled) return fn(NOOP_SPAN)
    const ctx = currentContext()
    const span = this.startSpan(name, {
      ...options,
      parent: options.parent ?? (ctx?.traceparent as string | undefined),
    })
    try {
      return ctx
        ? await runInContext(
            { ...ctx, span, traceId: span.traceId, spanId: span.spanId, traceparent: span.traceparent },
            () => fn(span),
          )
        : await fn(span)
    } catch (error) {
      span.recordError(error)
      throw error
    } finally {
      span.end()
    }
  }
}

/** What core binds: records nothing. */
export class NoopTracer extends Tracer {
  readonly enabled = false
  startSpan(): Span {
    return NOOP_SPAN
  }
}

/** A finished (or running) span, as `BasicTracer` keeps it. */
export class RecordedSpan implements Span {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly sampled: boolean
  readonly start = performance.timeOrigin + performance.now()
  endTime: number | undefined
  status: 'unset' | 'ok' | 'error' = 'unset'
  error: { name: string; message: string; stack?: string } | undefined
  readonly attributes: Attributes

  constructor(
    public name: string,
    readonly kind: SpanKind,
    attributes: Attributes,
    parent: string | undefined,
    private readonly onEnd: (span: RecordedSpan) => void,
  ) {
    const p = parseTraceparent(parent)
    this.traceId = p?.traceId ?? hex(16)
    this.spanId = hex(8)
    this.parentSpanId = p?.spanId
    this.sampled = p?.sampled ?? true
    this.attributes = { ...attributes }
  }

  get traceparent(): string {
    return `00-${this.traceId}-${this.spanId}-${this.sampled ? '01' : '00'}`
  }

  /** Milliseconds, once ended. */
  get duration(): number | undefined {
    return this.endTime === undefined ? undefined : this.endTime - this.start
  }

  updateName(name: string): void {
    this.name = name
  }

  setAttributes(attributes: Attributes): void {
    Object.assign(this.attributes, attributes)
  }

  recordError(error: unknown): void {
    this.status = 'error'
    this.error =
      error instanceof Error
        ? { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
        : { name: 'Error', message: String(error) }
  }

  end(): void {
    if (this.endTime !== undefined) return
    this.endTime = performance.timeOrigin + performance.now()
    if (this.status === 'unset') this.status = 'ok'
    this.onEnd(this)
  }
}

/** A tracer that records spans in memory (`finished`) and calls `onEnd`: tests, and the base of exporters. */
export class BasicTracer extends Tracer {
  readonly enabled = true
  readonly finished: RecordedSpan[] = []

  constructor(private readonly options: { onEnd?: (span: RecordedSpan) => void; keep?: number } = {}) {
    super()
  }

  startSpan(name: string, options: SpanOptions = {}): RecordedSpan {
    return new RecordedSpan(name, options.kind ?? 'internal', options.attributes ?? {}, options.parent, (span) => {
      if (this.options.keep !== 0) {
        this.finished.push(span)
        if (this.finished.length > (this.options.keep ?? 1000)) this.finished.shift()
      }
      this.options.onEnd?.(span)
    })
  }
}

/**
 * Metrics. Packages count and time their work through it; core binds a no-op one, `@cslug/telemetry` one that
 * aggregates and exports. Names follow OpenTelemetry conventions (`http.server.request.duration`, seconds).
 */
export abstract class Metrics {
  abstract readonly enabled: boolean
  /** A counter: `increment('cslug.mail.sent', { transport: 'smtp' })`. */
  abstract increment(name: string, attributes?: Attributes, by?: number): void
  /** A histogram value: durations (seconds), sizes. */
  abstract record(name: string, value: number, attributes?: Attributes): void
  /** A gauge read when metrics are collected: `observe('cslug.db.pool.idle', () => pool.idle)`. */
  abstract observe(name: string, read: () => number | Promise<number>, attributes?: Attributes): void
}

export class NoopMetrics extends Metrics {
  readonly enabled = false
  increment(): void {}
  record(): void {}
  observe(): void {}
}

/** Histogram buckets (seconds), as OpenTelemetry's HTTP duration recommends. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]

export type MetricPoint =
  | { name: string; type: 'counter'; attributes: Attributes; value: number }
  | {
      name: string
      type: 'histogram'
      attributes: Attributes
      count: number
      sum: number
      min: number
      max: number
      buckets: number[]
      /** Cumulative counts per bucket bound, then +Inf. */
      counts: number[]
    }
  | { name: string; type: 'gauge'; attributes: Attributes; value: number }

const keyOf = (name: string, attributes: Attributes = {}) =>
  `${name}|${JSON.stringify(
    Object.entries(attributes)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  )}`

/** Metrics aggregated in memory; `collect()` gives every point (gauges read then): tests, and the base of exporters. */
export class BasicMetrics extends Metrics {
  readonly enabled = true
  private readonly points = new Map<string, MetricPoint>()
  private readonly gauges = new Map<
    string,
    { name: string; read: () => number | Promise<number>; attributes: Attributes }
  >()

  constructor(private readonly buckets: number[] = DEFAULT_BUCKETS) {
    super()
  }

  increment(name: string, attributes: Attributes = {}, by = 1): void {
    const key = keyOf(name, attributes)
    const point = this.points.get(key)
    if (point?.type === 'counter') point.value += by
    else this.points.set(key, { name, type: 'counter', attributes, value: by })
  }

  record(name: string, value: number, attributes: Attributes = {}): void {
    const key = keyOf(name, attributes)
    let point = this.points.get(key)
    if (point?.type !== 'histogram') {
      point = {
        name,
        type: 'histogram',
        attributes,
        count: 0,
        sum: 0,
        min: value,
        max: value,
        buckets: this.buckets,
        counts: new Array(this.buckets.length + 1).fill(0),
      }
      this.points.set(key, point)
    }
    point.count++
    point.sum += value
    point.min = Math.min(point.min, value)
    point.max = Math.max(point.max, value)
    for (let i = 0; i <= this.buckets.length; i++)
      if (i === this.buckets.length || value <= (this.buckets[i] as number))
        point.counts[i] = (point.counts[i] ?? 0) + 1
  }

  observe(name: string, read: () => number | Promise<number>, attributes: Attributes = {}): void {
    this.gauges.set(keyOf(name, attributes), { name, read, attributes })
  }

  /** Every counter and histogram, and each gauge read now. */
  async collect(): Promise<MetricPoint[]> {
    const gauges = await Promise.all(
      [...this.gauges.values()].map(async (g) => ({
        name: g.name,
        type: 'gauge' as const,
        attributes: g.attributes,
        value: await Promise.resolve()
          .then(g.read)
          .catch(() => Number.NaN),
      })),
    )
    return [...[...this.points.values()].map((p) => structuredClone(p)), ...gauges]
  }
}
