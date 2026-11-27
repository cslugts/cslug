import type { Attributes, MetricPoint } from '@cslug/core'

/** `http.server.request.duration` → `http_server_request_duration_seconds` (durations and ages are in seconds). */
export function prometheusName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/^([0-9])/, '_$1')
  return /(duration|age)$/.test(name) ? `${base}_seconds` : base
}

const escapeValue = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

function labels(attributes: Attributes, extra: Record<string, string> = {}): string {
  const pairs = [
    ...Object.entries(attributes)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1'), String(v)]),
    ...Object.entries(extra),
  ]
  return pairs.length ? `{${pairs.map(([k, v]) => `${k}="${escapeValue(v as string)}"`).join(',')}}` : ''
}

const num = (v: number) => (Number.isNaN(v) ? 'NaN' : v === Infinity ? '+Inf' : v === -Infinity ? '-Inf' : String(v))

/** The Prometheus text exposition format (version 0.0.4) of every point. */
export function prometheusText(points: MetricPoint[]): string {
  const byName = new Map<string, MetricPoint[]>()
  for (const p of points) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
  const out: string[] = []
  for (const [name, list] of byName) {
    const first = list[0] as MetricPoint
    const n = prometheusName(name)
    if (first.type === 'counter') {
      out.push(`# TYPE ${n}_total counter`)
      for (const p of list) out.push(`${n}_total${labels(p.attributes)} ${num((p as { value: number }).value)}`)
    } else if (first.type === 'gauge') {
      out.push(`# TYPE ${n} gauge`)
      for (const p of list) out.push(`${n}${labels(p.attributes)} ${num((p as { value: number }).value)}`)
    } else {
      out.push(`# TYPE ${n} histogram`)
      for (const p of list) {
        const h = p as Extract<MetricPoint, { type: 'histogram' }>
        for (const [i, bound] of h.buckets.entries())
          out.push(`${n}_bucket${labels(h.attributes, { le: String(bound) })} ${h.counts[i]}`)
        out.push(`${n}_bucket${labels(h.attributes, { le: '+Inf' })} ${h.counts[h.buckets.length]}`)
        out.push(`${n}_sum${labels(h.attributes)} ${num(h.sum)}`)
        out.push(`${n}_count${labels(h.attributes)} ${h.count}`)
      }
    }
  }
  return `${out.join('\n')}\n`
}
