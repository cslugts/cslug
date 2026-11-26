import { beforeEach, describe, expect, test } from 'bun:test'
import { Application, EventBus, Logger } from '@cslug/core'
import { testApp } from '@cslug/testing'
import { ValidationError } from '@cslug/validation'
import { backoffDelay, Job, parseRead, Queue, QueuedListenerJob } from '../src'
import { ChainingJob, NoPayloadJob, RecordJob, reset, runs, TodoCompleted, ValidatedJob } from './support'

const t = testApp({
  create() {
    const app = new Application({ configs: {} })
    app.singleton(Logger, () => Logger.null())
    return app
  },
  fakes: ['queue'],
})
beforeEach(reset)

describe('dispatch (guide 11) with the fake', () => {
  test('dispatch() is typed from Job<Payload> and recorded with its options', async () => {
    t.clock.travelTo('2027-05-14T08:00:00Z')
    const id = await RecordJob.dispatch({ n: 1 })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    await RecordJob.dispatch({ n: 2 }).delay('3d')
    await RecordJob.dispatch({ n: 3 }).at(new Date('2027-05-15T08:00:00Z'))
    await RecordJob.dispatch({ n: 4 }).onQueue('urgent').priority(1)
    await NoPayloadJob.dispatch()

    const q = t.queue as NonNullable<typeof t.queue>
    q.assertPushed(RecordJob, (j) => j.payload.n === 1 && j.delay === undefined && j.queue === 'default')
    q.assertPushed(RecordJob, (j) => j.payload.n === 2 && j.delay === 3 * 86_400_000)
    q.assertPushed(RecordJob, (j) => j.payload.n === 3 && j.runAt?.toISOString() === '2027-05-15T08:00:00.000Z')
    q.assertPushed(RecordJob, (j) => j.queue === 'urgent' && j.priority === 1)
    q.assertPushedCount(RecordJob, 4)
    q.assertPushed(NoPayloadJob)
    expect(() => q.assertNotPushed(NoPayloadJob)).toThrow(/not to be pushed/)
    expect(() => q.assertPushed(ChainingJob)).toThrow(/Expected ChainingJob to be pushed/)
  })

  test('resolve(Queue).dispatch(Job, payload) is the same thing', async () => {
    await t.resolve(Queue).dispatch(RecordJob, { n: 7 })
    t.queue?.assertPushed(RecordJob, (j) => j.payload.n === 7)
  })

  test('unique(): ignored while one with the same key is waiting', async () => {
    expect(await RecordJob.dispatch({ n: 1 }).unique('k')).not.toBeNull()
    expect(await RecordJob.dispatch({ n: 2 }).unique('k')).toBeNull()
    t.queue?.assertPushedCount(RecordJob, 1)
    await t.queue?.drain()
    expect(await RecordJob.dispatch({ n: 3 }).unique('k')).not.toBeNull()
  })

  test('drain() runs everything pushed, including jobs pushed by those jobs', async () => {
    await ChainingJob.dispatch({ depth: 2 })
    expect(await t.queue?.drain()).toBe(3)
    expect(runs.map((r) => r.payload)).toEqual([{ depth: 2 }, { depth: 1 }, { depth: 0 }])
  })

  test('Job.schema(): the payload is checked on dispatch', async () => {
    await ValidatedJob.dispatch({ eventId: 'evt_1' })
    // @ts-expect-error the payload type comes from the schema
    const bad = ValidatedJob.dispatch({ eventId: 42 })
    await expect(Promise.resolve(bad)).rejects.toBeInstanceOf(ValidationError)
    await t.queue?.drain()
    expect(runs).toEqual([{ job: 'validated', payload: { eventId: 'evt_1' } }])
  })

  test('queued listeners become jobs on their queue', async () => {
    const bus = t.resolve(EventBus)
    const before = bus.dispatchQueued
    bus.dispatchQueued = async ({ listener, event, payload, options }) => {
      await t
        .resolve(Queue)
        .dispatch(QueuedListenerJob, { listener: listener.name, event: event.eventName, payload })
        .onQueue(options.queue ?? 'default')
    }
    try {
      await TodoCompleted.emit({ todoId: 't1' })
      await Bun.sleep(5) // queued listeners go out after commit (next tick outside a transaction)
      t.queue?.assertPushed(QueuedListenerJob, (j) => j.queue === 'listeners' && j.payload.event === 'todo.completed')
      await t.queue?.drain()
      expect(runs).toEqual([{ job: 'listener', payload: { todoId: 't1' } }])
    } finally {
      bus.dispatchQueued = before
    }
  })
})

describe('backoff', () => {
  test('a duration, one per retry, or exponential with a cap', () => {
    expect(backoffDelay('30s', 1)).toBe(30_000)
    expect(backoffDelay(['1s', '10s'], 1)).toBe(1000)
    expect(backoffDelay(['1s', '10s'], 5)).toBe(10_000)
    const exp = Job.exponential('30s', { max: '2m' })
    expect([1, 2, 3, 4].map(exp)).toEqual([30_000, 60_000, 120_000, 120_000])
    const jittered = Job.exponential('10s', { jitter: true })(1)
    expect(jittered).toBeGreaterThanOrEqual(5000)
    expect(jittered).toBeLessThanOrEqual(15_000)
  })

  test('priority() takes 1 … 10', () => {
    expect(() => RecordJob.dispatch({ n: 1 }).priority(0)).toThrow(RangeError)
  })
})

describe('XREADGROUP replies (spike c, finding 1)', () => {
  test('RESP3 map and RESP2 array parse to the same rows; a timeout is empty', () => {
    const rows = [['1-0', ['job', '{}']]]
    expect(parseRead({ 'p:q:default': rows })).toEqual([['p:q:default', rows]] as never)
    expect(parseRead([['p:q:default', rows]])).toEqual([['p:q:default', rows]] as never)
    expect(parseRead(null)).toEqual([])
  })
})
