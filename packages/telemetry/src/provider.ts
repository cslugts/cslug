import { hostname } from 'node:os'
import {
  type Attributes,
  BasicMetrics,
  BasicTracer,
  ForbiddenError,
  Logger,
  type LogLevel,
  Metrics,
  ServiceProvider,
  Tracer,
} from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { bearerMatches, ipAllowed, LOOPBACK } from './access'
import { keyValues, OtlpExporter, type OtlpOptions } from './otlp'
import { prometheusText } from './prometheus'

export type TelemetryConfig = {
  /** `service.name` (default: `app.name`). */
  serviceName?: string
  serviceVersion?: string
  /** 0–1: the share of new traces exported (default 1). Continued traces follow the caller; failed spans always go. */
  sampleRate?: number
  /**
   * An OpenTelemetry collector (or a vendor's OTLP endpoint). The endpoint and headers default to the standard
   * `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,key2=value2`); no endpoint, no export.
   */
  otlp?:
    | (Partial<OtlpOptions> & {
        traces?: boolean
        metrics?: boolean
        /** Send log lines too, from this level (`true`: `info`). Default: false. */
        logs?: boolean | LogLevel
      })
    | false
  /** `GET /metrics` in Prometheus format (with @cslug/http). Default: on, loopback only. */
  metrics?:
    | {
        path?: string
        /** Allowed with `Authorization: Bearer <token>`. */
        token?: string
        /** Allowed from these addresses or IPv4 ranges (`10.0.0.0/8`). Default, without a token: loopback only. */
        allow?: string[]
      }
    | false
}

/** What the provider set up: the exporter (if any) and the in-memory metrics. */
export class Telemetry {
  constructor(
    readonly metrics: BasicMetrics,
    readonly exporter: OtlpExporter | undefined,
  ) {}

  /** Send queued spans and logs now (tests, the end of a script). */
  async flush(): Promise<void> {
    await this.exporter?.flush()
  }
}

function headersFromEnv(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  const out: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=')
    if (at > 0) out[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim())
  }
  return out
}

/**
 * Binds a recording `Tracer` and `Metrics` in place of core's no-op ones, exports traces, metrics and (opt in) logs
 * to an OTLP/HTTP collector, and serves `/metrics` for Prometheus. List it first in `bootstrap/providers.ts`, so it
 * shuts down last and flushes what the others recorded.
 */
export class TelemetryProvider extends ServiceProvider {
  private config(): TelemetryConfig {
    return this.app.config<TelemetryConfig | undefined>('telemetry') ?? {}
  }

  register() {
    const config = this.config()
    const otlp = config.otlp === false ? undefined : (config.otlp ?? {})
    const endpoint = otlp?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    const metrics = new BasicMetrics()
    const resource: Attributes = {
      'service.name': config.serviceName ?? this.app.config<string | undefined>('app.name') ?? 'cslug-app',
      'service.version': config.serviceVersion,
      'service.instance.id': `${hostname()}:${process.pid}`,
      'deployment.environment.name': this.app.config<string | undefined>('app.env'),
      'cslug.role': process.env.CSLUG_ROLE,
      'telemetry.sdk.name': 'cslug',
      'telemetry.sdk.language': 'js',
    }
    const exporter =
      otlp && endpoint
        ? new OtlpExporter(
            { ...otlp, endpoint, headers: otlp.headers ?? headersFromEnv(process.env.OTEL_EXPORTER_OTLP_HEADERS) },
            keyValues(resource),
            otlp.metrics === false ? undefined : () => metrics.collect(),
          )
        : undefined
    const traces = exporter && otlp?.traces !== false
    const tracer = new BasicTracer({
      keep: 0,
      sampleRate: config.sampleRate ?? 1,
      onEnd: (span) => {
        if (traces && (span.sampled || span.status === 'error')) exporter.span(span)
      },
    })
    this.app.singleton(Tracer, () => tracer)
    this.app.singleton(Metrics, () => metrics)
    this.app.singleton(Telemetry, () => new Telemetry(metrics, exporter))
  }

  async boot() {
    const config = this.config()
    const { metrics, exporter } = this.app.resolve(Telemetry)
    metrics.observe('process.memory.usage', () => process.memoryUsage().rss)
    metrics.observe('process.uptime', () => process.uptime())
    const logs = config.otlp ? config.otlp.logs : undefined
    if (exporter && logs)
      this.app.resolve(Logger).addTarget({
        type: 'custom',
        format: 'json',
        level: logs === true ? 'info' : logs,
        write: (l) => exporter.log(l),
      })
    exporter?.start()
    await this.metricsRoute(config.metrics, metrics)
  }

  async shutdown() {
    await this.app.resolve(Telemetry).exporter?.shutdown()
  }

  private async metricsRoute(options: TelemetryConfig['metrics'], metrics: BasicMetrics) {
    if (options === false) return
    const http = await import('@cslug/http').catch(() => undefined)
    if (!http || !this.app.has(http.Router)) return
    const { path = '/metrics', token, allow } = options ?? {}
    const allowed = (ctx: HttpContext) =>
      (token !== undefined && bearerMatches(ctx.request.header('authorization') ?? null, token)) ||
      ipAllowed(ctx.request.ip(), allow ?? (token ? [] : LOOPBACK))
    this.app.resolve(http.Router).load((r) => {
      r.get(path, async (ctx) => {
        if (!allowed(ctx)) throw new ForbiddenError('telemetry.metrics_forbidden', 'Metrics are not public.')
        return new Response(prometheusText(await metrics.collect()), {
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' },
        })
      }).name('telemetry.metrics')
    })
  }
}
