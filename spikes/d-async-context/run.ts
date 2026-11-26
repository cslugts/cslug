/**
 * Spike (d): AsyncLocalStorage in Bun. Is the per-request context (request id, locale, user, ambient transaction)
 * correct under concurrency, and what does it cost? Run: `bun run.ts` (needs `ab`; Redis on :6379 is optional).
 */
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { RedisClient } from 'bun'
import { als, ctx } from './context'

const results: Record<string, unknown> = { bun: Bun.version, checks: [] as unknown[] }
const check = (name: string, ok: boolean, detail?: unknown) =>
  (results.checks as unknown[]).push({ check: name, ok, ...(detail === undefined ? {} : { detail }) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (n: number) => Math.floor(Math.random() * n)

// ── 1. correctness: does each concurrent unit of work keep its own context across every kind of hop? ──
console.error('§ 1. correctness')
let redis: RedisClient | null = null
try {
  redis = new RedisClient('redis://localhost:6379/15')
  await redis.send('PING', [])
} catch {
  redis = null
}
const echo = Bun.serve({ port: 0, fetch: () => new Response('ok') })
const emitter = new EventEmitter()
let emitted: string | undefined
emitter.on('booking.paid', () => {
  emitted = als.getStore()?.requestId
})

async function* pages() {
  for (let i = 0; i < 3; i++) {
    await sleep(rand(3))
    yield als.getStore()?.requestId
  }
}

type Hop = [name: string, run: () => Promise<string | undefined>]
const hops: Hop[] = [
  ['await', async () => (await Promise.resolve(), als.getStore()?.requestId)],
  ['setTimeout', () => new Promise((r) => setTimeout(() => r(als.getStore()?.requestId), rand(5)))],
  ['setImmediate', () => new Promise((r) => setImmediate(() => r(als.getStore()?.requestId)))],
  ['queueMicrotask', () => new Promise((r) => queueMicrotask(() => r(als.getStore()?.requestId)))],
  ['Bun.sleep', async () => (await Bun.sleep(rand(3)), als.getStore()?.requestId)],
  ['Promise.all children', async () => {
    const ids = await Promise.all([1, 2, 3].map(async () => (await sleep(rand(3)), als.getStore()?.requestId)))
    return ids.every((i) => i === ids[0]) ? ids[0] : 'MIXED'
  }],
  ['async generator', async () => {
    const seen: (string | undefined)[] = []
    for await (const id of pages()) seen.push(id)
    return seen.every((i) => i === seen[0]) ? seen[0] : 'MIXED'
  }],
  ['EventEmitter (sync listener)', async () => (emitter.emit('booking.paid'), emitted)],
  ['fetch() to a local server', async () => (await (await fetch(`http://localhost:${echo.port}`)).text(), als.getStore()?.requestId)],
  ['Bun.file read', async () => (await Bun.file(import.meta.path).text(), als.getStore()?.requestId)],
  ['crypto.subtle', async () => (await crypto.subtle.digest('SHA-256', new Uint8Array(32)), als.getStore()?.requestId)],
]
if (redis) {
  const r = redis
  hops.push(['Bun.redis command', async () => (await r.send('PING', []), als.getStore()?.requestId)])
}

const N = 2000
const wrong: Record<string, number> = {}
await Promise.all(
  Array.from({ length: N }, (_, i) =>
    als.run({ requestId: `req-${i}`, locale: 'fr', userId: null, tx: null }, async () => {
      await sleep(rand(5))
      for (const [name, run] of hops) {
        const got = await run()
        if (got !== `req-${i}`) wrong[name] = (wrong[name] ?? 0) + 1
      }
    }),
  ),
)
for (const [name] of hops) {
  check(`context survives: ${name} (${N} concurrent units)`, !wrong[name], wrong[name] ? { wrong: wrong[name] } : undefined)
}
echo.stop(true)
redis?.close()

// nested run = ambient transaction; restored on exit, also after a throw
await als.run({ requestId: 'outer', locale: 'fr', userId: null, tx: null }, async () => {
  let inside: unknown
  try {
    await als.run({ ...ctx(), tx: { depth: 1 } }, async () => {
      await sleep(1)
      inside = ctx().tx?.depth
      throw new Error('rollback')
    })
  } catch {}
  check('nested run (transaction) is visible inside and restored after a throw', inside === 1 && ctx().tx === null)
})
check('outside any run there is no context', als.getStore() === undefined)

// a streamed response body: the ReadableStream pulls after the handler returned
{
  const srv = Bun.serve({
    port: 0,
    fetch: () =>
      als.run({ requestId: 'stream-req', locale: 'fr', userId: null, tx: null }, () => {
        let n = 0
        return new Response(
          new ReadableStream({
            async pull(c) {
              await sleep(2)
              c.enqueue(`${als.getStore()?.requestId ?? 'NONE'}\n`)
              if (++n === 3) c.close()
            },
          }),
        )
      }),
  })
  const body = await (await fetch(`http://localhost:${srv.port}`)).text()
  srv.stop(true)
  const lines = body.trim().split('\n')
  results.streamedBody = lines
  check(
    'context inside a streamed response body (ReadableStream.pull after the handler returned)',
    lines.every((l) => l === 'stream-req'),
    lines,
  )
}

// ── 2. micro-benchmark ──────────────────────────────────────────────────────────────────────────────
console.error('§ 2. micro-benchmark')
const bench = async (name: string, iterations: number, fn: () => unknown) => {
  for (let i = 0; i < 10_000; i++) await fn()
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < iterations; i++) await fn()
  return { name, nsPerOp: Math.round((Bun.nanoseconds() - t0) / iterations) }
}
const c0 = { requestId: 'x', locale: 'fr', userId: null, tx: null }
results.micro = [
  await bench('baseline: async fn with 1 await', 300_000, async () => {
    await Promise.resolve()
  }),
  await bench('als.run + 1 await', 300_000, () => als.run(c0, async () => {
    await Promise.resolve()
  })),
  await bench('als.run + 10 getStore() + 3 awaits', 300_000, () => als.run(c0, async () => {
    for (let a = 0; a < 3; a++) {
      await Promise.resolve()
      for (let r = 0; r < 3; r++) ctx()
    }
    ctx()
  })),
]
als.run(c0, () => {
  for (let i = 0; i < 100_000; i++) als.getStore() // warm-up
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < 1_000_000; i++) als.getStore()
  results.getStoreNs = +((Bun.nanoseconds() - t0) / 1_000_000).toFixed(1)
})

// ── 3. HTTP throughput: plain vs ALS vs heavy ─────────────────────────────────────────────────────────
console.error('§ 3. HTTP throughput (ab)')
async function start(mode: string) {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], { env: { ...process.env, MODE: mode }, stdout: 'pipe' })
  const reader = proc.stdout.getReader()
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim())
  reader.releaseLock()
  return { proc, port }
}
async function ab(port: number) {
  const out = Bun.spawn(['ab', '-q', '-k', '-c', '64', '-n', '100000', `http://127.0.0.1:${port}/`], { stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(out.stdout).text()
  await out.exited
  const rps = Number(text.match(/Requests per second:\s+([\d.]+)/)?.[1])
  const failed = Number(text.match(/Failed requests:\s+(\d+)/)?.[1])
  const p99 = Number(text.match(/\s99%\s+(\d+)/)?.[1])
  return { rps, failed, p99 }
}
const modes = ['plain', 'als', 'heavy'] as const
const http: Record<string, { rps: number[]; failed: number; p99ms: number[] }> = {}
for (const mode of modes) http[mode] = { rps: [], failed: 0, p99ms: [] }
for (let round = 0; round < 3; round++) {
  for (const mode of modes) {
    const { proc, port } = await start(mode)
    await ab(port) // warm-up
    const r = await ab(port)
    http[mode]!.rps.push(Math.round(r.rps))
    http[mode]!.failed += r.failed
    http[mode]!.p99ms.push(r.p99)
    proc.kill()
    await proc.exited
  }
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const base = median(http.plain!.rps)
results.http = Object.fromEntries(
  modes.map((m) => [
    m,
    {
      rpsMedian: median(http[m]!.rps),
      rpsRuns: http[m]!.rps,
      p99ms: http[m]!.p99ms,
      failed: http[m]!.failed,
      vsPlain: `${(((median(http[m]!.rps) - base) / base) * 100).toFixed(1)}%`,
    },
  ]),
)
check('no failed HTTP requests in any mode', modes.every((m) => http[m]!.failed === 0))

console.log(JSON.stringify(results, null, 2))
const failed = (results.checks as { ok: boolean }[]).filter((c) => !c.ok).length
console.log(failed ? `\n✖ ${failed} check(s) failed` : '\n✔ all checks passed')
process.exit(failed ? 1 : 0)
