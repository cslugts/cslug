import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Application, BasicMetrics, BasicTracer, Metrics, runInContext, Tracer } from '@cslug/core'
import { type Database, querySummary, sql } from '../src'
import { describeDb, testDatabase } from './support'

test('querySummary: the operation and first table, never values', () => {
  expect(querySummary('select * from "bookings" where id = $1')).toEqual({
    operation: 'SELECT',
    summary: 'SELECT bookings',
  })
  expect(querySummary('  insert into public.cslug_jobs (id) values ($1)').summary).toBe('INSERT public.cslug_jobs')
  expect(querySummary('update users set name = $1').summary).toBe('UPDATE users')
  expect(querySummary('begin').summary).toBe('BEGIN')
})

describeDb('database tracing', () => {
  let db: Database
  let drop: () => Promise<void>
  beforeAll(async () => {
    ;({ db, drop } = await testDatabase())
  })
  afterAll(() => drop())

  test('a client span per query under the current span; failed queries recorded; duration histogram', async () => {
    const app = new Application()
    await app.start()
    const tracer = new BasicTracer()
    const metrics = new BasicMetrics()
    app.swap(Tracer, tracer)
    app.swap(Metrics, metrics)
    await runInContext({ app, scope: app.createScope() }, () =>
      tracer.span('GET /bookings', { kind: 'server' }, async () => {
        await db.value(sql`select ${'secret-value'}::text as v`)
        await expect(db.exec(sql`select * from missing_table`)).rejects.toThrow()
      }),
    )
    const [ok, failed, request] = tracer.finished
    expect(ok).toMatchObject({ name: 'SELECT', kind: 'client', parentSpanId: request?.spanId, status: 'ok' })
    expect(JSON.stringify(ok?.attributes)).not.toContain('secret-value')
    expect(failed).toMatchObject({ name: 'SELECT missing_table', status: 'error' })
    const histogram = (await metrics.collect()).find((p) => p.name === 'db.client.operation.duration')
    expect(histogram).toMatchObject({ type: 'histogram', count: 2 })
    await app.shutdown()
  })
})
