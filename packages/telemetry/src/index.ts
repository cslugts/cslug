/**
 * @cslug/telemetry: records the spans and metrics cslug's packages report (through core's `Tracer` and `Metrics`)
 * and exports them, with logs, to any OpenTelemetry collector over OTLP/HTTP; serves `/metrics` for Prometheus.
 */
export { bearerMatches, ipAllowed } from './access'
export { encodeLogs, encodeMetrics, encodeSpans, keyValues, OtlpExporter, type OtlpOptions } from './otlp'
export { prometheusName, prometheusText } from './prometheus'
export { Telemetry, type TelemetryConfig, TelemetryProvider } from './provider'
