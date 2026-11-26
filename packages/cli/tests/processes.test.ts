import { describe, expect, test } from 'bun:test'
import { plannedProcesses, Supervisor } from '../src'
import { BIN, FIXTURE, freePort, waitFor } from './support'

describe('cslug start: planning', () => {
  test('defaults: one web, one default worker, the scheduler', () => {
    expect(plannedProcesses()).toEqual([
      { name: 'web', argv: ['serve'] },
      { name: 'worker', argv: ['queue:work', '--queues=default'] },
      { name: 'scheduler', argv: ['schedule:work'] },
    ])
  })

  test('cslug.config.ts processes (guide 21)', () => {
    const planned = plannedProcesses({
      web: { instances: 2 },
      worker: [
        { queues: ['payments'], concurrency: 1 },
        { queues: ['default', 'notifications'], concurrency: 10 },
      ],
      scheduler: false,
    })
    expect(planned.map((p) => `${p.name}: ${p.argv.join(' ')}`)).toEqual([
      'web#1: serve --reuse-port',
      'web#2: serve --reuse-port',
      'worker#1: queue:work --queues=payments --concurrency=1',
      'worker#2: queue:work --queues=default,notifications --concurrency=10',
    ])
  })

  test('flags replace the config: --web --worker=2, --worker=payments:1', () => {
    expect(plannedProcesses({ scheduler: true }, { web: true, worker: ['2'] }).map((p) => p.name)).toEqual([
      'web',
      'worker#1',
      'worker#2',
    ])
    expect(plannedProcesses({}, { worker: ['payments:1', 'default,mail:5'] }).map((p) => p.argv.join(' '))).toEqual([
      'queue:work --queues=payments --concurrency=1',
      'queue:work --queues=default,mail --concurrency=5',
    ])
  })
})

describe('Supervisor', () => {
  const fake = `${FIXTURE}/fake-child.ts`

  test('forwards SIGTERM, waits for the children to drain, exits 0', async () => {
    const lines: string[] = []
    const s = new Supervisor(
      [
        { name: 'web', argv: ['serve'] },
        { name: 'worker', argv: ['work'] },
      ],
      { cwd: FIXTURE, bin: fake, prefix: false, log: (l) => lines.push(l) },
    ).start()
    await Bun.sleep(300)
    expect(Object.values(s.pids).every((p) => typeof p === 'number')).toBe(true)
    expect(await s.stop()).toBe(0)
    expect(lines.join('\n')).toMatch(/➜ web +pid \d+/)
  })

  test('restarts a crashing child with backoff', async () => {
    const lines: string[] = []
    const s = new Supervisor([{ name: 'bad', argv: ['crash'] }], {
      cwd: FIXTURE,
      bin: fake,
      prefix: false,
      log: (l) => lines.push(l),
    }).start()
    await waitFor(async () => lines.filter((l) => l.includes('➜ bad')).length >= 2, 5000)
    expect(lines.some((l) => l.includes('bad exited (1); restarting in 1s'))).toBe(true)
    // 0 if it was waiting to restart, 1 if a fresh copy crashed again while stopping: both are honest
    expect([0, 1]).toContain(await s.stop())
  })

  test('kills a child that does not drain in time', async () => {
    const s = new Supervisor([{ name: 'stuck', argv: ['stuck'] }], {
      cwd: FIXTURE,
      bin: `${FIXTURE}/../stuck-child.ts`,
      prefix: false,
      shutdownTimeout: 0.3,
      log: () => {},
    }).start()
    await Bun.sleep(300)
    const started = Date.now()
    expect(await s.stop()).toBe(1) // killed, not a clean exit
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('end to end (M3 done criteria)', () => {
  test('cslug serve: SIGTERM drains the in-flight request, refuses new ones, exits 0; 422 shape', async () => {
    const port = freePort()
    const proc = Bun.spawn([process.execPath, BIN, 'serve', `--port=${port}`], {
      cwd: FIXTURE,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const base = `http://127.0.0.1:${port}`
    await waitFor(async () => (await fetch(`${base}/health/live`)).ok)

    const invalid = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title: '', priority: 'urgent' }),
    })
    expect(invalid.status).toBe(422)
    expect(invalid.headers.get('content-type')).toContain('application/problem+json')
    expect(await invalid.json()).toMatchObject({
      status: 422,
      code: 'validation.failed',
      errors: { title: [expect.any(String)], priority: [expect.any(String)] },
    })

    const inflight = fetch(`${base}/api/slow?ms=800`).then(async (r) => [r.status, await r.json()])
    await Bun.sleep(150)
    proc.kill('SIGTERM')
    await Bun.sleep(100)
    await expect(fetch(`${base}/health/live`)).rejects.toThrow()
    expect(await inflight).toEqual([200, { done: true }])
    expect(await proc.exited).toBe(0)
  }, 20_000)

  test('cslug start --web: supervises serve; SIGTERM → everything drains, exit 0', async () => {
    const port = freePort()
    const proc = Bun.spawn([process.execPath, BIN, 'start', '--web'], {
      cwd: FIXTURE,
      env: { ...process.env, PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const base = `http://127.0.0.1:${port}`
    await waitFor(async () => (await fetch(`${base}/health/live`)).ok)
    const inflight = fetch(`${base}/api/slow?ms=600`).then((r) => r.status)
    await Bun.sleep(150)
    proc.kill('SIGTERM')
    expect(await inflight).toBe(200)
    expect(await proc.exited).toBe(0)
    const out = await new Response(proc.stdout).text()
    expect(out).toContain('cslug  start')
    expect(out).toMatch(/➜ web +pid \d+/)
  }, 20_000)
})
