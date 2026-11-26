/** Child process for the crash test: reads one job as consumer "crashy", reports it, then hangs until killed. */
import { RedisClient } from 'bun'

const [url, stream, group] = process.argv.slice(2) as [string, string, string]
const r = new RedisClient(url)
// RESP3 map: { [stream]: [[id, fields], …] }
const reply = (await r.send('XREADGROUP', ['GROUP', group, 'crashy', 'COUNT', '1', 'BLOCK', '2000', 'STREAMS', stream, '>'])) as Record<
  string,
  [string, string[]][]
> | null
const id = reply?.[stream]?.[0]?.[0]
console.log(JSON.stringify({ read: id ?? null }))
await new Promise(() => {}) // never acks: simulates a worker that dies mid-job
