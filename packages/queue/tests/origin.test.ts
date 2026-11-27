import { expect, test } from 'bun:test'
import { Application, Logger, resolve, runInContext } from '@cslug/core'
import { envelopeOf, Job, runJob } from '../src'

const dispatched: ReturnType<typeof envelopeOf>[] = []

class ChildJob extends Job<{ n: number }> {
  static jobName = 'test.origin.child'
  handle() {
    resolve(Logger).info('child ran')
  }
}

/** A job that "dispatches" another one (envelopeOf is what dispatch builds). */
class ParentJob extends Job<{ n: number }> {
  static jobName = 'test.origin.parent'
  handle({ n }: { n: number }) {
    resolve(Logger).info('parent ran')
    dispatched.push(envelopeOf(ChildJob, { n: n + 1 }))
  }
}

test('a job records where the work came from; jobs it dispatches keep the first request; logs carry it', async () => {
  const lines: string[] = []
  const app = new Application({ configs: { log: { write: (l: string) => lines.push(l) } } })
  await app.start()

  // outside any context: no origin
  expect(envelopeOf(ParentJob, { n: 1 }).origin).toBeUndefined()

  // from a request (with a trace)
  const fromRequest = runInContext(
    { app, scope: app.createScope(), requestId: 'req-1', traceparent: '00-abc-def-01' },
    () => envelopeOf(ParentJob, { n: 1 }),
  )
  expect(fromRequest.origin).toEqual({ requestId: 'req-1', traceparent: '00-abc-def-01' })

  await runJob(app, fromRequest, 0)
  const child = dispatched.at(-1) as ReturnType<typeof envelopeOf>
  expect(child.origin).toEqual({ requestId: 'req-1', traceparent: '00-abc-def-01' }) // not job:<parent id>
  await runJob(app, child, 0)

  const logs = lines.map((l) => JSON.parse(l))
  expect(logs.find((l) => l.msg === 'parent ran')).toMatchObject({
    requestId: `job:${fromRequest.id}`,
    jobId: fromRequest.id,
    originRequestId: 'req-1',
  })
  expect(logs.find((l) => l.msg === 'child ran')).toMatchObject({ jobId: child.id, originRequestId: 'req-1' })
  await app.shutdown()
})
