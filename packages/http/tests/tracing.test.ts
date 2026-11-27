import { expect, test } from 'bun:test'
import { BasicMetrics, BasicTracer, Logger, Metrics, NotFoundError, Tracer } from '@cslug/core'
import { httpApp } from './support'

test('a server span per request: continues the caller trace, named after the route, 5xx recorded; duration histogram', async () => {
  const lines: string[] = []
  const log = new Logger({ write: (l) => lines.push(l) })
  const { app, call } = await httpApp((r) => {
    r.get('/bookings/:id', ({ params }) => {
      log.info('showing', { id: params.id })
      return { id: params.id }
    }).name('bookings.show')
    r.get('/broken', () => {
      throw new Error('db down')
    })
    r.get('/missing', () => {
      throw new NotFoundError('booking')
    })
  })
  const tracer = new BasicTracer()
  const metrics = new BasicMetrics()
  app.swap(Tracer, tracer)
  app.swap(Metrics, metrics)

  const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  expect((await call('/bookings/b1', { headers: { traceparent: parent } })).status).toBe(200)
  expect((await call('/broken')).status).toBe(500)
  expect((await call('/missing')).status).toBe(404)

  const [ok, broken, missing] = tracer.finished
  expect(ok).toMatchObject({
    name: 'GET /bookings/:id',
    kind: 'server',
    status: 'ok',
    parentSpanId: '00f067aa0ba902b7',
  })
  expect(ok?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
  expect(ok?.attributes).toMatchObject({ 'http.route': '/bookings/:id', 'http.response.status_code': 200 })
  expect(broken).toMatchObject({ name: 'GET /broken', status: 'error' })
  expect(broken?.error?.message).toBe('db down')
  expect(missing).toMatchObject({ status: 'ok' }) // 4xx is the client's error, not the server's
  expect(missing?.traceId).not.toBe(ok?.traceId)

  const handlerLine = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'showing')
  expect(handlerLine).toMatchObject({ traceId: ok?.traceId, spanId: ok?.spanId })

  const durations = (await metrics.collect()).filter((p) => p.name === 'http.server.request.duration')
  expect(durations.map((p) => p.attributes['http.response.status_code']).sort()).toEqual([200, 404, 500])
  await app.shutdown()
})
