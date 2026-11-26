/**
 * Spike (c): can Bun.redis (no dependency) carry cslug's queue on Redis Streams?
 * Run: `bun run.ts [redis-url]` (default redis://localhost:6379/15). Uses only keys prefixed `spike-c:`, deletes them
 * at the end.
 */
import { RedisClient } from 'bun'
import { join } from 'node:path'

const URL = process.argv[2] ?? 'redis://localhost:6379/15'
const P = 'spike-c:'
const results: Record<string, unknown> = { checks: [] as unknown[] }
const check = (name: string, ok: boolean, detail?: unknown) =>
  (results.checks as unknown[]).push({ check: name, ok, ...(detail === undefined ? {} : { detail }) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const client = (opts?: ConstructorParameters<typeof RedisClient>[1]) => new RedisClient(URL, opts)
/** Settle a promise within `ms`, so a hanging command is reported instead of freezing the run. */
const within = async <T>(p: Promise<T>, ms: number) => {
  const t0 = performance.now()
  const r = await Promise.race([
    p.then((value) => ({ value }), (e) => ({ error: String(e).slice(0, 120) })),
    sleep(ms).then(() => ({ timeout: `no answer after ${ms} ms` })),
  ])
  return { ...r, ms: Math.round(performance.now() - t0) } as { value?: T; error?: string; timeout?: string; ms: number }
}
type Entry = [id: string, fields: string[]]
/** Bun.redis speaks RESP3: XREAD/XREADGROUP return a map { stream: entries }, not RESP2's [[stream, entries]]. */
type ReadReply = Record<string, Entry[]> | [string, Entry[]][] | null
const entriesOf = (reply: unknown): Entry[] => {
  if (!reply) return []
  if (Array.isArray(reply)) return (reply[0]?.[1] as Entry[] | undefined) ?? []
  return Object.values(reply as Record<string, Entry[]>)[0] ?? []
}

const admin = client()
const cleanup = async () => {
  let cursor = '0'
  do {
    const [next, keys] = (await admin.send('SCAN', [cursor, 'MATCH', `${P}*`, 'COUNT', '1000'])) as [string, string[]]
    if (keys.length) await admin.send('DEL', keys)
    cursor = next
  } while (cursor !== '0')
}
await cleanup()
results.redis = String(await admin.send('INFO', ['server']))
  .split('\r\n')
  .find((l) => l.startsWith('redis_version'))

// ── 1. basics: group, add, read, ack; reply shapes ──
console.error("\u00a7 1. basics: group, add, read, ack; reply shapes")
{
  const s = `${P}basic`
  await admin.send('XGROUP', ['CREATE', s, 'workers', '$', 'MKSTREAM'])
  const id = (await admin.send('XADD', [s, '*', 'job', 'SendCheckin', 'payload', '{"bookingId":"b1"}'])) as string
  const read = (await admin.send('XREADGROUP', ['GROUP', 'workers', 'c1', 'COUNT', '10', 'STREAMS', s, '>'])) as ReadReply
  const entry = entriesOf(read)[0]
  results.replyShapes = { xadd: id, xreadgroup: read }
  check('XADD / XREADGROUP / XACK work through send()', entry?.[0] === id && entry?.[1][1] === 'SendCheckin')
  check('XREADGROUP reply is a RESP3 map { stream: entries }', !!read && !Array.isArray(read) && s in read)
  const acked = await admin.send('XACK', [s, 'workers', id])
  const pending = (await admin.send('XPENDING', [s, 'workers'])) as [number, ...unknown[]]
  check('acked job leaves the pending list', acked === 1 && pending[0] === 0)
  const empty = (await admin.send('XREADGROUP', ['GROUP', 'workers', 'c1', 'COUNT', '1', 'BLOCK', '100', 'STREAMS', s, '>'])) as ReadReply
  check('blocking read on an empty stream times out with null', empty === null)
}

// ── 2. a blocking read stalls its own connection, but not other clients ──
console.error("\u00a7 2. a blocking read stalls its own connection, but not other clients")
{
  const s = `${P}block`
  await admin.send('XGROUP', ['CREATE', s, 'workers', '$', 'MKSTREAM'])
  const reader = client()
  const other = client()
  await reader.send('PING', [])
  await other.send('PING', [])
  const t0 = performance.now()
  const blocked = reader.send('XREADGROUP', ['GROUP', 'workers', 'c1', 'COUNT', '1', 'BLOCK', '3000', 'STREAMS', s, '>'])
  await sleep(50)
  const pings: number[] = []
  for (let i = 0; i < 50; i++) {
    const p0 = performance.now()
    await other.send('PING', [])
    pings.push(performance.now() - p0)
  }
  const sameConn = performance.now()
  const samePing = reader.send('PING', []) // queued behind the blocking read on the same connection
  await sleep(100)
  const addAt = performance.now()
  await admin.send('XADD', [s, '*', 'job', 'x'])
  const got = (await blocked) as ReadReply
  const delivery = performance.now() - addAt
  await samePing
  const samePingWait = performance.now() - sameConn
  check('other clients are not slowed by a blocked reader', Math.max(...pings) < 20, {
    maxPingMs: +Math.max(...pings).toFixed(2),
  })
  check('a blocked reader wakes as soon as a job is added', got !== null && delivery < 20, { deliveryMs: +delivery.toFixed(2) })
  check(
    'a command on the SAME connection waits for the blocking read: workers need a dedicated connection',
    samePingWait > 90,
    { waitedMs: Math.round(samePingWait) },
  )
  results.blockElapsedMs = Math.round(performance.now() - t0)
  reader.close()
  other.close()
}

// ── 3. crash recovery: a killed worker's job is reclaimed after its lease (XAUTOCLAIM) ──
console.error("\u00a7 3. crash recovery: a killed worker's job is reclaimed after its lease (XAUTOCLAIM)")
{
  const s = `${P}crash`
  await admin.send('XGROUP', ['CREATE', s, 'workers', '$', 'MKSTREAM'])
  const id = (await admin.send('XADD', [s, '*', 'job', 'ReleaseStage', 'payload', '{"bookingId":"b9"}'])) as string
  const child = Bun.spawn(['bun', join(import.meta.dir, 'crash-worker.ts'), URL, s, 'workers'], { stdout: 'pipe' })
  const reader = child.stdout.getReader()
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value)) as { read: string | null }
  child.kill('SIGKILL')
  await child.exited
  check('child worker read the job, then was SIGKILLed before acking', first.read === id, { signal: child.signalCode })

  const lease = 500
  const early = (await admin.send('XAUTOCLAIM', [s, 'workers', 'rescuer', String(lease), '0', 'COUNT', '10'])) as [string, Entry[], string[]]
  check('job is not reclaimed before the lease expires', early[1].length === 0)
  await sleep(lease + 100)
  const claimed = (await admin.send('XAUTOCLAIM', [s, 'workers', 'rescuer', String(lease), '0', 'COUNT', '10'])) as [string, Entry[], string[]]
  const detail = (await admin.send('XPENDING', [s, 'workers', '-', '+', '10'])) as [string, string, number, number][]
  check('after the lease, another worker reclaims the job with its payload', claimed[1][0]?.[0] === id && claimed[1][0]?.[1][3] === '{"bookingId":"b9"}')
  check('delivery count is tracked (2 = first try + reclaim), usable for max attempts', detail[0]?.[3] === 2, { xpending: detail[0] })
  await admin.send('XACK', [s, 'workers', id])
  const left = (await admin.send('XPENDING', [s, 'workers'])) as [number]
  check('reclaimed job acked: nothing pending', left[0] === 0)
}

// ── 4. Lua: atomic promotion of delayed jobs (sorted set → stream) ──
console.error("\u00a7 4. Lua: atomic promotion of delayed jobs (sorted set \u2192 stream)")
{
  const delayed = `${P}delayed`
  const s = `${P}lua`
  const script = `
    local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
    for _, job in ipairs(due) do
      redis.call('XADD', KEYS[2], '*', 'job', job)
      redis.call('ZREM', KEYS[1], job)
    end
    return #due`
  const sha = (await admin.send('SCRIPT', ['LOAD', script])) as string
  const now = Date.now()
  await admin.send('ZADD', [delayed, String(now + 300), '{"job":"Reminder","n":1}', String(now - 1), '{"job":"Reminder","n":0}'])
  const first = await admin.send('EVALSHA', [sha, '2', delayed, s, String(Date.now()), '100'])
  await sleep(350)
  const second = await admin.send('EVALSHA', [sha, '2', delayed, s, String(Date.now()), '100'])
  const len = await admin.send('XLEN', [s])
  check('Lua script promotes only due jobs, atomically (1 now, 1 after 300 ms)', first === 1 && second === 1 && len === 2)
  let noscript = ''
  try {
    await admin.send('EVALSHA', ['0'.repeat(40), '0'])
  } catch (e) {
    noscript = String(e)
  }
  check('unknown script hash raises NOSCRIPT (so the driver can reload and retry)', /NOSCRIPT/.test(noscript), noscript.slice(0, 80))
}

// ── 5. unique jobs ──
console.error("\u00a7 5. unique jobs")
{
  const k = `${P}unique:checkin:b1:pickup`
  const a = await admin.send('SET', [k, 'job-1', 'NX', 'PX', '60000'])
  const b = await admin.send('SET', [k, 'job-2', 'NX', 'PX', '60000'])
  check('unique key: first SET NX wins, the duplicate is refused', a === 'OK' && b === null, { a, b })
}

// ── 6. throughput and latency ──
console.error("\u00a7 6. throughput and latency")
{
  const s = `${P}bench`
  await admin.send('XGROUP', ['CREATE', s, 'workers', '$', 'MKSTREAM'])
  const N = 20_000
  const producer = client()
  const tEnq = performance.now()
  const adds: Promise<unknown>[] = []
  for (let i = 0; i < N; i++) adds.push(producer.send('XADD', [s, '*', 'job', 'Bench', 'payload', `{"i":${i}}`]))
  await Promise.all(adds)
  const enqueueMs = performance.now() - tEnq

  const consumers = 4
  let done = 0
  const tCon = performance.now()
  await Promise.all(
    Array.from({ length: consumers }, async (_, c) => {
      const conn = client()
      while (done < N) {
        const r = (await conn.send('XREADGROUP', ['GROUP', 'workers', `w${c}`, 'COUNT', '100', 'BLOCK', '200', 'STREAMS', s, '>'])) as ReadReply
        const entries = entriesOf(r)
        if (!entries.length) continue
        await conn.send('XACK', [s, 'workers', ...entries.map((e) => e[0])])
        done += entries.length
      }
      conn.close()
    }),
  )
  const consumeMs = performance.now() - tCon

  // latency: one blocked consumer, jobs added one by one
  const ls = `${P}latency`
  await admin.send('XGROUP', ['CREATE', ls, 'workers', '$', 'MKSTREAM'])
  const reader = client()
  const lat: number[] = []
  const M = 500
  const consumer = (async () => {
    while (lat.length < M) {
      const r = (await reader.send('XREADGROUP', ['GROUP', 'workers', 'l1', 'COUNT', '10', 'BLOCK', '1000', 'STREAMS', ls, '>'])) as ReadReply
      for (const [id, f] of entriesOf(r)) {
        lat.push(performance.now() - Number(f[1]))
        await reader.send('XACK', [ls, 'workers', id])
      }
    }
  })()
  for (let i = 0; i < M; i++) {
    await producer.send('XADD', [ls, '*', 't', String(performance.now())])
    await sleep(1)
  }
  await consumer
  lat.sort((a, b) => a - b)
  results.performance = {
    enqueue: { jobs: N, ms: Math.round(enqueueMs), perSecond: Math.round(N / (enqueueMs / 1000)) },
    consume: { jobs: N, consumers, ms: Math.round(consumeMs), perSecond: Math.round(N / (consumeMs / 1000)) },
    latencyMs: { p50: +lat[Math.floor(M * 0.5)]!.toFixed(2), p99: +lat[Math.floor(M * 0.99)]!.toFixed(2), max: +lat[M - 1]!.toFixed(2) },
  }
  check('20k jobs enqueued and consumed (auto-pipelined, 4 consumers)', done >= N)
  producer.close()
  reader.close()
}

// ── 7. connection killed by the server: does the client reconnect? ──
console.error("\u00a7 7. connection killed by the server: does the client reconnect?")
{
  const victim = client()
  const id = String(await victim.send('CLIENT', ['ID']))
  await admin.send('CLIENT', ['KILL', 'ID', id])
  await sleep(100)
  const first = await within(victim.send('PING', []), 3000)
  const second = await within(victim.send('PING', []), 3000)
  const newId = second.value === 'PONG' ? String((await within(victim.send('CLIENT', ['ID']), 1000)).value) : null
  results.reconnect = { firstCommandAfterKill: first, secondCommand: second, oldId: id, newId, connected: victim.connected }
  check('client reconnects automatically after the server drops it', second.value === 'PONG' && newId !== id, results.reconnect)

  // a blocked reader whose connection is killed: error or silent?
  const s = `${P}killblock`
  await admin.send('XGROUP', ['CREATE', s, 'workers', '$', 'MKSTREAM'])
  // default client: an in-flight blocking read on a killed connection never settles, and the client is wedged
  const wedged = client()
  const wid = String(await wedged.send('CLIENT', ['ID']))
  const wedgedRead = wedged.send('XREADGROUP', ['GROUP', 'workers', 'k0', 'COUNT', '1', 'BLOCK', '2000', 'STREAMS', s, '>'])
  await sleep(50)
  await admin.send('CLIENT', ['KILL', 'ID', wid])
  const wedgedOutcome = await within(wedgedRead, 4000)
  const wedgedNext = await within(wedged.send('PING', []), 2000)
  results.knownIssueDefaultClient = { blockedRead: wedgedOutcome, nextCommand: wedgedNext, connected: wedged.connected }
  wedged.close()

  // recommended for worker connections: autoReconnect off, the worker recreates the connection itself
  const blockedConn = client({ autoReconnect: false })
  const bid = String(await blockedConn.send('CLIENT', ['ID']))
  const blockedRead = blockedConn.send('XREADGROUP', ['GROUP', 'workers', 'k1', 'COUNT', '1', 'BLOCK', '5000', 'STREAMS', s, '>'])
  await sleep(50)
  await admin.send('CLIENT', ['KILL', 'ID', bid])
  const outcome = await within(blockedRead, 7000)
  results.blockedReaderKilled = outcome
  check(
    'worker connection (autoReconnect: false): a killed blocking read rejects at once, so the worker can reconnect',
    !!outcome.error && outcome.ms < 1000,
    outcome,
  )
  blockedConn.close()
  const fresh = client({ autoReconnect: false })
  const again = await within(fresh.send('XREADGROUP', ['GROUP', 'workers', 'k1', 'COUNT', '1', 'BLOCK', '100', 'STREAMS', s, '>']), 2000)
  check('a fresh connection resumes reading from the group', 'value' in again && !again.error, again)
  fresh.close()
  victim.close()
}

// ── 8. graceful shutdown: can a worker stop while blocked? ──
console.error("\u00a7 8. graceful shutdown: can a worker stop while blocked?")
{
  const s = `${P}shutdown`
  await admin.send('XGROUP', ['CREATE', s, 'workers', '$', 'MKSTREAM'])
  const conn = client()
  await conn.send('PING', [])
  const blocked = conn.send('XREADGROUP', ['GROUP', 'workers', 'sd', 'COUNT', '1', 'BLOCK', '10000', 'STREAMS', s, '>'])
  await sleep(50)
  conn.close()
  const outcome = await within(blocked, 3000)
  const ms = outcome.ms
  results.shutdown = outcome
  check('close() on a blocked worker connection returns quickly (no 10 s wait on SIGTERM)', ms < 500, results.shutdown)
}

// ── 9. trimming ──
console.error("\u00a7 9. trimming")
{
  const s = `${P}trim`
  for (let i = 0; i < 2000; i++) admin.send('XADD', [s, 'MAXLEN', '~', '1000', '*', 'i', String(i)])
  await admin.send('PING', [])
  const len = (await admin.send('XLEN', [s])) as number
  check('XADD MAXLEN ~ keeps the stream bounded', len < 1200, { len })
}

await cleanup()
check('all spike keys removed', ((await admin.send('DBSIZE', [])) as number) === 0)
admin.close()

console.log(JSON.stringify(results, null, 2))
const failed = (results.checks as { ok: boolean }[]).filter((c) => !c.ok).length
console.log(failed ? `\n✖ ${failed} check(s) failed` : '\n✔ all checks passed')
process.exit(failed ? 1 : 0)
