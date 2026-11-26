/**
 * Bun.serve with the same handler work in three modes (MODE env):
 *   plain  no AsyncLocalStorage; values passed explicitly
 *   als    als.run per request; 10 context reads across 3 awaits (what a typical cslug request does)
 *   heavy  als.run + a nested run (an ambient transaction) + 50 reads across 6 awaits
 */
import { als, ctx } from './context'

const MODE = process.env.MODE ?? 'als'
const step = async (n: number) => {
  await Promise.resolve()
  return n + 1
}

async function work(reads: number, awaits: number, read: () => string) {
  let acc = 0
  for (let a = 0; a < awaits; a++) {
    acc = await step(acc)
    for (let r = 0; r < reads / awaits; r++) acc += read().length
  }
  return acc
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  fetch(req) {
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID()
    if (MODE === 'plain') {
      return work(10, 3, () => requestId).then((n) => Response.json({ n, requestId }))
    }
    return als.run({ requestId, locale: 'fr', userId: null, tx: null }, async () => {
      const n = await work(10, 3, () => ctx().requestId)
      if (MODE === 'heavy') {
        await als.run({ ...ctx(), tx: { depth: 1 } }, () => work(50, 6, () => ctx().locale))
      }
      return Response.json({ n, requestId: ctx().requestId })
    })
  },
})
console.log(server.port)
