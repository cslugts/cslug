import { describe, expect, test } from 'bun:test'
import {
  Application,
  BasicMetrics,
  BasicTracer,
  currentContext,
  Logger,
  Metrics,
  NoopTracer,
  parseTraceparent,
  runInContext,
  Tracer,
} from '../src'

const inApp = <T>(fn: () => T) => {
  const app = new Application()
  return runInContext({ app, scope: app.createScope() }, fn)
}

describe('Tracer', () => {
  test('core binds no-op contracts: fn runs, nothing recorded, the context is untouched', async () => {
    const app = new Application()
    await app.start()
    expect(app.resolve(Tracer)).toBeInstanceOf(NoopTracer)
    expect(app.resolve(Tracer).enabled).toBe(false)
    expect(app.resolve(Metrics).enabled).toBe(false)
    const value = await runInContext({ app, scope: app.createScope() }, () =>
      app.resolve(Tracer).span('work', {}, () => currentContext()?.traceId ?? 'none'),
    )
    expect(value).toBe('none')
    await app.shutdown()
  })

  test('spans nest through the context; logs carry traceId and spanId; errors are recorded and rethrown', async () => {
    const tracer = new BasicTracer()
    const lines: string[] = []
    const log = new Logger({ write: (l) => lines.push(l) })
    await inApp(() =>
      tracer.span('outer', { kind: 'server', attributes: { a: 1 } }, async (outer) => {
        log.info('in outer')
        await tracer.span('inner', {}, async () => {
          expect(tracer.current()?.name).toBe('inner')
          log.info('in inner')
        })
        outer.updateName('GET /bookings/:id')
        await expect(
          tracer.span('broken', {}, () => {
            throw new Error('boom')
          }),
        ).rejects.toThrow('boom')
      }),
    )
    const [inner, broken, outer] = tracer.finished
    expect([inner?.name, broken?.name, outer?.name]).toEqual(['inner', 'broken', 'GET /bookings/:id'])
    expect(inner?.traceId).toBe(outer?.traceId as string)
    expect(inner?.parentSpanId).toBe(outer?.spanId)
    expect(outer?.parentSpanId).toBeUndefined()
    expect(outer?.kind).toBe('server')
    expect(outer?.attributes).toEqual({ a: 1 })
    expect(outer?.status).toBe('ok')
    expect(broken?.status).toBe('error')
    expect(broken?.error?.message).toBe('boom')
    expect(outer?.duration).toBeGreaterThanOrEqual(0)
    const [l1, l2] = lines.map((l) => JSON.parse(l))
    expect(l1).toMatchObject({ traceId: outer?.traceId, spanId: outer?.spanId })
    expect(l2).toMatchObject({ traceId: outer?.traceId, spanId: inner?.spanId })
  })

  test('W3C traceparent: a parent continues the caller trace; malformed values start a new one', () => {
    const tracer = new BasicTracer()
    const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    const span = tracer.startSpan('child', { parent })
    expect(span.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(span.parentSpanId).toBe('00f067aa0ba902b7')
    expect(span.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/)
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')?.sampled).toBe(false)
    for (const bad of ['', 'garbage', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, '01-abc-def-01'])
      expect(parseTraceparent(bad)).toBeUndefined()
    const fresh = tracer.startSpan('root', { parent: 'garbage' })
    expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(fresh.parentSpanId).toBeUndefined()
  })

  test('BasicTracer keeps the last `keep` spans and calls onEnd once per span', () => {
    const ended: string[] = []
    const tracer = new BasicTracer({ keep: 2, onEnd: (s) => ended.push(s.name) })
    for (const name of ['a', 'b', 'c']) {
      const s = tracer.startSpan(name)
      s.end()
      s.end()
    }
    expect(ended).toEqual(['a', 'b', 'c'])
    expect(tracer.finished.map((s) => s.name)).toEqual(['b', 'c'])
  })
})

describe('Metrics', () => {
  test('counters and histograms aggregate per name and attributes; gauges are read at collect', async () => {
    const metrics = new BasicMetrics([0.1, 1])
    metrics.increment('jobs', { queue: 'default' })
    metrics.increment('jobs', { queue: 'default' }, 2)
    metrics.increment('jobs', { queue: 'mail' })
    for (const v of [0.05, 0.5, 3]) metrics.record('duration', v, { route: '/a', ignored: undefined })
    let waiting = 4
    metrics.observe('waiting', () => waiting)
    metrics.observe('broken', () => {
      throw new Error('redis down')
    })
    waiting = 7
    const points = await metrics.collect()
    expect(points.filter((p) => p.name === 'jobs').map((p) => p.type === 'counter' && p.value)).toEqual([3, 1])
    const h = points.find((p) => p.name === 'duration')
    expect(h).toMatchObject({ type: 'histogram', count: 3, sum: 3.55, min: 0.05, max: 3, counts: [1, 2, 3] })
    expect(points.find((p) => p.name === 'waiting')).toMatchObject({ type: 'gauge', value: 7 })
    expect(
      Number.isNaN(
        points.find((p) => p.name === 'broken')?.type === 'gauge' &&
          (points.find((p) => p.name === 'broken') as { value: number }).value,
      ),
    ).toBe(true)
  })
})
