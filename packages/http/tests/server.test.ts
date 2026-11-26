import { expect, test } from 'bun:test'
import { Application, HEALTH_CHECKS, healthCheck, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider, Router } from '../src'

test('a real server: health endpoints, and shutdown lets in-flight requests finish', async () => {
  const app = new Application({ root: '/nonexistent', configs: { http: { port: 0, shutdownTimeout: '2s' } } })
  app.useProviders([HttpProvider])
  app.singleton(Logger, () => Logger.null())
  let dbUp = true
  app.singleton(healthCheck('database'), () => ({
    name: 'database',
    check: async () => {
      if (!dbUp) throw new Error('connection refused')
    },
  }))
  app.tag([healthCheck('database')], HEALTH_CHECKS)
  await app.start()
  app.resolve(Router).load((r) => {
    r.get('/slow', async () => {
      await Bun.sleep(300)
      return 'finished'
    })
  })
  const server = app.resolve(HttpKernel).listen({ port: 0 })
  const base = `http://localhost:${server.port}`

  expect(await (await fetch(`${base}/health/live`)).json()).toEqual({ status: 'ok' })
  expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({ status: 'ok', checks: { database: 'ok' } })
  dbUp = false
  const down = await fetch(`${base}/health/ready`)
  expect([down.status, (await down.json()).checks]).toEqual([503, { database: 'connection refused' }])

  const inFlight = fetch(`${base}/slow`).then((r) => r.text())
  await Bun.sleep(50)
  const t0 = performance.now()
  await app.shutdown() // HttpProvider.shutdown → kernel.stop()
  expect(await inFlight).toBe('finished')
  expect(performance.now() - t0).toBeGreaterThan(150)
})
