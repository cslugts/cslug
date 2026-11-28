import { afterAll, describe, expect, test } from 'bun:test'
import { Database, sql } from '@cslug/database'
import { testApp } from '@cslug/testing'
import { SQL } from 'bun'
import { findWorkflow, WorkflowResumeJob, Workflows } from '../src'
import { fixtureApp } from './fixture/app'
import { OrderPaid } from './fixture/app/events'
import { FlakyWorkflow, knobs, OrderWorkflow } from './fixture/app/workflows/order-workflow'

const { DATABASE_URL, REDIS_URL } = process.env

describe.skipIf(!DATABASE_URL || !REDIS_URL)('workflows (guide 25)', () => {
  const name = `cslug_workflow_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const admin = DATABASE_URL
    ? new SQL(Object.assign(new URL(DATABASE_URL), { pathname: '/postgres' }).toString(), { max: 1 })
    : undefined
  afterAll(async () => {
    await admin?.unsafe(`drop database if exists "${name}" with (force)`)
    await admin?.close()
  })
  const t = testApp({
    async create() {
      await admin?.unsafe(`create database "${name}"`)
      return fixtureApp(Object.assign(new URL(DATABASE_URL as string), { pathname: `/${name}` }).toString())
    },
    fakes: ['queue'],
    database: 'truncate', // runs commit for real (advisory lock, one transaction per step)
  })

  const workflows = () => t.resolve(Workflows)
  const run = (id: string) => workflows().find(id)
  const effects = (runId: string) =>
    t.resolve(Database).many<{ name: string }>(sql`select name from effects where run_id = ${runId} order by name`)
  const resumes = () => t.queue.of(WorkflowResumeJob)

  test('start: a pending run and one resume job; the same id again is the same run', async () => {
    const first = await OrderWorkflow.start({ orderId: 'o1' }, { id: 'order:o1' })
    const again = await OrderWorkflow.start({ orderId: 'o1' }, { id: 'order:o1' })
    expect([first, again]).toEqual([
      { id: 'order:o1', created: true },
      { id: 'order:o1', created: false },
    ])
    expect(await run('order:o1')).toMatchObject({
      workflow: 'fixture.order',
      status: 'pending',
      input: { orderId: 'o1' },
    })
    expect(resumes().map((j) => j.payload)).toEqual([{ runId: 'order:o1' }])
    expect(findWorkflow('fixture.order')).toBe(OrderWorkflow) // discovered from app/workflows
    const generated = await FlakyWorkflow.start({ tries: 1 })
    expect(generated.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('the whole story: step once, sleep, wait for an event, wait for a signal, finish', async () => {
    knobs.changed = false
    const { id } = await OrderWorkflow.start({ orderId: 'o2' })
    await workflows().resume(id)
    let r = await run(id)
    expect(r).toMatchObject({ status: 'sleeping' })
    expect(r?.wakeAt?.getTime()).toBe(t.clock.now().getTime() + 86_400_000)
    expect(resumes().at(-1)?.runAt?.getTime()).toBe(r?.wakeAt?.getTime()) // the wake-up job

    await workflows().resume(id) // too early: replays, runs nothing again, stays asleep
    expect(await effects(id)).toEqual([{ name: 'reserve' }])
    expect((await run(id))?.status).toBe('sleeping')

    t.clock.advance('1d')
    await workflows().resume(id)
    r = await run(id)
    expect(r).toMatchObject({ status: 'waiting', waitingFor: 'event:order.paid', waitingMatch: { orderId: 'o2' } })

    const before = resumes().length
    await OrderPaid.emit({ orderId: 'other', amount: 1n })
    expect(resumes()).toHaveLength(before) // not this run's order
    await OrderPaid.emit({ orderId: 'o2', amount: 6600n })
    expect(resumes()).toHaveLength(before + 1)
    await workflows().resume(id)
    expect(await run(id)).toMatchObject({ status: 'waiting', waitingFor: 'signal:approve' })

    await workflows().signal(id, 'approve', { approved: true })
    await workflows().resume(id)
    r = await run(id)
    expect(r).toMatchObject({ status: 'completed', output: { outcome: 'shipped r-o2 6600', approved: true } })
    expect(r?.finishedAt).toBeInstanceOf(Date)
    expect(await effects(id)).toEqual([{ name: 'reserve' }, { name: 'ship' }])

    const journal = await workflows().store.journal(id)
    expect(journal.map((e) => `${e.kind}:${e.name}:${e.status}`)).toEqual([
      'step:reserve:completed',
      'now:now:completed',
      'uuid:uuid:completed',
      'sleep:sleep:completed',
      'wait:event:order.paid:completed',
      'wait:signal:approve:completed',
      'step:ship:completed',
    ])
    expect(journal[0]?.result).toEqual({ reservation: 'r-o2', at: '2027-01-01T00:00:00.000Z', cents: '1200' })
    await workflows().resume(id) // a finished run: nothing happens
    expect(await effects(id)).toHaveLength(2)
  })

  test('timeouts: no event within 3 days → undefined; a signal sent early is kept for the run', async () => {
    const { id } = await OrderWorkflow.start({ orderId: 'o3' })
    await workflows().resume(id)
    t.clock.advance('1d')
    await workflows().resume(id)
    t.clock.advance('3d')
    await workflows().resume(id)
    expect(await run(id)).toMatchObject({ status: 'completed', output: { outcome: 'expired' } })

    const early = await OrderWorkflow.start({ orderId: 'o4' })
    await workflows().signal(early.id, 'approve', { approved: false }) // before the run waits for it
    await workflows().resume(early.id)
    t.clock.advance('1d')
    await workflows().resume(early.id)
    await OrderPaid.emit({ orderId: 'o4', amount: 1n })
    await workflows().resume(early.id)
    expect(await run(early.id)).toMatchObject({ status: 'completed', output: { approved: false } })
  })

  test('a failing step is retried after its backoff without holding a worker; its writes roll back', async () => {
    knobs.failures = 2
    const { id } = await FlakyWorkflow.start({ tries: 3 })
    await workflows().resume(id)
    let r = await run(id)
    expect(r?.status).toBe('sleeping')
    expect(r?.wakeAt?.getTime()).toBe(t.clock.now().getTime() + 60_000)
    expect(await effects(id)).toEqual([]) // the failed attempt's insert rolled back
    t.clock.advance('1m')
    await workflows().resume(id)
    t.clock.advance('2m')
    await workflows().resume(id)
    r = await run(id)
    expect(r).toMatchObject({ status: 'completed', output: 'ok' })
    expect(await effects(id)).toEqual([{ name: 'attempt' }])
    expect((await workflows().store.journal(id))[0]).toMatchObject({ status: 'completed', attempts: 3 })
  })

  test('after its last try the run fails with the step error', async () => {
    knobs.failures = 5
    const { id } = await FlakyWorkflow.start({ tries: 2 })
    await workflows().resume(id)
    t.clock.advance('1m')
    await workflows().resume(id)
    expect(await run(id)).toMatchObject({
      status: 'failed',
      error: { code: 'workflow.step_failed', message: 'Step "flaky" failed: gateway down' },
    })
    knobs.failures = 0
  })

  test('changed code under a running run: workflow.nondeterministic', async () => {
    knobs.changed = false
    const { id } = await OrderWorkflow.start({ orderId: 'o5' })
    await workflows().resume(id)
    knobs.changed = true
    t.clock.advance('1d')
    await workflows().resume(id)
    expect((await run(id))?.error).toMatchObject({ code: 'workflow.nondeterministic' })
    knobs.changed = false
  })

  test('cancel: the run stops; a finished run cannot be cancelled', async () => {
    const { id } = await OrderWorkflow.start({ orderId: 'o6' })
    await workflows().resume(id)
    expect(await workflows().cancel(id)).toBe(true)
    t.clock.advance('1d')
    await workflows().resume(id)
    expect((await run(id))?.status).toBe('cancelled')
    expect(await workflows().cancel(id)).toBe(false)
  })

  test('started inside a transaction that rolls back: no run, no job', async () => {
    const before = resumes().length
    await expect(
      t.resolve(Database).transaction(async () => {
        await OrderWorkflow.start({ orderId: 'o7' }, { id: 'order:o7' })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await run('order:o7')).toBeNull()
    expect(resumes()).toHaveLength(before)
  })

  test('a run whose workflow no process knows fails as workflow.unknown', async () => {
    await workflows().store.insert('ghost', 'fixture.gone', {})
    await workflows().resume('ghost')
    expect((await run('ghost'))?.error).toMatchObject({ code: 'workflow.unknown' })
  })
})
