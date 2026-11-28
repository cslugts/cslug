import { afterAll, describe, expect, test } from 'bun:test'
import { BasicTracer, type Command, ConsoleIO, DESCRIBE, type DescribeSection, runInContext, Tracer } from '@cslug/core'
import { Database, sql } from '@cslug/database'
import { testApp } from '@cslug/testing'
import { SQL } from 'bun'
import {
  findWorkflow,
  WorkflowCancelCommand,
  WorkflowListCommand,
  WorkflowPruneCommand,
  WorkflowResumeJob,
  WorkflowRetryCommand,
  WorkflowShowCommand,
  Workflows,
} from '../src'
import { fixtureApp } from './fixture/app'
import { OrderPaid } from './fixture/app/events'
import { BookingSaga, FlakyWorkflow, knobs, OrderWorkflow, saga } from './fixture/app/workflows/order-workflow'

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
    fakes: ['queue', 'workflows'],
    database: 'truncate', // runs commit for real (advisory lock, one transaction per step)
  })

  const workflows = () => t.resolve(Workflows)
  const run = (id: string) => workflows().find(id)
  const effects = (runId: string) =>
    t.resolve(Database).many<{ name: string }>(sql`select name from effects where run_id = ${runId} order by id`)
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

  test('cancel: cancelling until its next wake-up (queued at once), then cancelled; not twice', async () => {
    const { id } = await OrderWorkflow.start({ orderId: 'o6' })
    await workflows().resume(id)
    const jobs = resumes().length
    expect(await workflows().cancel(id)).toBe(true)
    expect((await run(id))?.status).toBe('cancelling')
    expect(resumes()).toHaveLength(jobs + 1)
    expect(await workflows().cancel(id)).toBe(false)
    await workflows().resume(id)
    expect(await run(id)).toMatchObject({ status: 'cancelled', error: null })
    expect(await workflows().cancel(id)).toBe(false)

    const never = await OrderWorkflow.start({ orderId: 'o6b' }) // cancelled before it ran
    await workflows().cancel(never.id)
    await workflows().resume(never.id)
    expect((await run(never.id))?.status).toBe('cancelled')
    expect(await workflows().store.journal(never.id)).toEqual([])
  })

  describe('sagas', () => {
    const toTheEnd = async (bookingId: string) => {
      const { id } = await BookingSaga.start({ bookingId })
      await workflows().resume(id)
      await workflows().signal(id, 'go')
      await workflows().resume(id)
      return id
    }

    test('a step fails for good: the finished steps are undone in reverse, once; the run is compensated', async () => {
      saga.confirmFails = true
      saga.refundFailures = 0
      const id = await toTheEnd('b1')
      expect(await run(id)).toMatchObject({
        status: 'compensated',
        error: { code: 'workflow.step_failed', message: 'Step "confirm" failed: operator unreachable' },
      })
      expect((await effects(id)).map((e) => e.name)).toEqual(['note', 'refund attempt c-h-b1', 'release h-b1'])
      const journal = await workflows().store.journal(id)
      expect(journal.filter((e) => e.kind === 'compensate').map((e) => `${e.seq} ${e.name} ${e.status}`)).toEqual([
        '-2 compensate:charge completed',
        '-1 compensate:hold completed',
      ])
      await workflows().resume(id) // finished: nothing runs again
      expect(await effects(id)).toHaveLength(3)
    })

    test('a compensation that fails is retried after its backoff (the run is compensating meanwhile)', async () => {
      saga.confirmFails = true
      saga.refundFailures = 1
      const id = await toTheEnd('b2')
      const r = await run(id)
      expect(r?.status).toBe('compensating')
      expect(r?.wakeAt?.getTime()).toBe(t.clock.now().getTime() + 60_000)
      t.clock.advance('1m')
      await workflows().resume(id)
      expect((await run(id))?.status).toBe('compensated')
      expect((await effects(id)).map((e) => e.name)).toEqual([
        'note',
        'refund attempt c-h-b2', // once: the failed attempt's insert rolled back with it
        'release h-b2',
      ])
    })

    test('a compensation that fails on its last try: compensation_failed, the earlier steps are left', async () => {
      saga.confirmFails = true
      saga.refundFailures = 10
      const id = await toTheEnd('b3')
      for (let i = 0; i < 3; i++) {
        t.clock.advance('10m')
        await workflows().resume(id)
      }
      expect(await run(id)).toMatchObject({
        status: 'compensation_failed',
        error: { code: 'workflow.compensation_failed', message: 'Compensating "charge" failed: refund refused' },
      })
      expect((await effects(id)).map((e) => e.name)).toEqual(['note']) // no release: the refund never succeeded
      saga.refundFailures = 0
    })

    test('cancelling a run undoes its finished steps; one that succeeds keeps its result', async () => {
      saga.refundFailures = 0
      const { id } = await BookingSaga.start({ bookingId: 'b4' })
      await workflows().resume(id) // waiting for "go"
      await workflows().cancel(id)
      await workflows().resume(id)
      expect(await run(id)).toMatchObject({ status: 'cancelled', error: null })
      expect((await effects(id)).map((e) => e.name)).toEqual(['note', 'refund attempt c-h-b4', 'release h-b4'])

      saga.confirmFails = false
      const ok = await toTheEnd('b5')
      expect(await run(ok)).toMatchObject({ status: 'completed', output: 'done' })
      expect((await effects(ok)).map((e) => e.name)).toEqual(['note'])
    })
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

  describe('operations', () => {
    class Captured extends ConsoleIO {
      out = ''
      override write(text: string) {
        this.out += text
      }
      override error(text: string) {
        this.out += text
      }
    }
    /** A command's handle() as the CLI runs it, with captured output. */
    const command = async <C extends new () => Command>(cmd: C, args: Record<string, unknown>) => {
      const io = new Captured()
      t.swap(ConsoleIO, io)
      const code = await runInContext({ app: t.app, scope: t.app.createScope() }, () =>
        (new cmd() as unknown as { handle(a: unknown): unknown }).handle(args),
      )
      return { code: typeof code === 'number' ? code : 0, out: io.out }
    }

    test('retry: a failed run starts again from its failed step, with fresh attempts', async () => {
      knobs.failures = 5
      const { id } = await FlakyWorkflow.start({ tries: 2 })
      await workflows().resume(id)
      t.clock.advance('1m')
      await workflows().resume(id)
      expect((await run(id))?.status).toBe('failed')
      knobs.failures = 0
      const jobs = resumes().length
      expect(await command(WorkflowRetryCommand, { id })).toMatchObject({ code: 0 })
      expect(await run(id)).toMatchObject({ status: 'pending', error: null, finishedAt: null })
      expect(resumes()).toHaveLength(jobs + 1)
      await workflows().resume(id) // at once: a retried step has no wake-up time
      expect(await run(id)).toMatchObject({ status: 'completed', output: 'ok' })
      expect((await workflows().store.journal(id))[0]).toMatchObject({ status: 'completed', attempts: 1 })
      expect((await command(WorkflowRetryCommand, { id })).code).toBe(1) // not failed any more
    })

    test('retry after a failed compensation: compensating again, then compensated', async () => {
      saga.confirmFails = true
      saga.refundFailures = 10
      const { id } = await BookingSaga.start({ bookingId: 'b9' })
      await workflows().resume(id)
      await workflows().signal(id, 'go')
      await t.workflows.runUntilIdle() // fast-forwards over the refund's retries
      expect((await run(id))?.status).toBe('compensation_failed')
      saga.refundFailures = 0
      expect(await workflows().retry(id)).toBe(true)
      expect((await run(id))?.status).toBe('compensating')
      await t.workflows.runUntilIdle()
      await t.workflows.assertStatus(id, 'compensated')
      expect((await effects(id)).map((e) => e.name)).toEqual(['note', 'refund attempt c-h-b9', 'release h-b9'])
    })

    test('list, show, cancel and prune', async () => {
      const a = await OrderWorkflow.start({ orderId: 'l1' }, { id: 'list:a' })
      await FlakyWorkflow.start({ tries: 1 }, { id: 'list:b' })
      expect((await workflows().list({ workflow: 'fixture.flaky' })).map((r) => r.id)).toEqual(['list:b'])
      expect((await workflows().list({ status: 'pending' })).map((r) => r.id).sort()).toEqual(['list:a', 'list:b'])
      const listed = await command(WorkflowListCommand, { status: 'pending', limit: 50, json: false })
      expect(listed.out).toContain('list:a')
      expect(listed.out).toContain('fixture.order')

      await workflows().resume(a.id)
      const shown = await command(WorkflowShowCommand, { id: a.id, json: false })
      expect(shown.out).toContain('list:a  fixture.order  sleeping')
      expect(shown.out).toMatch(/step\s+reserve\s+completed/)
      expect((await command(WorkflowShowCommand, { id: 'nope', json: false })).code).toBe(1)

      expect((await command(WorkflowCancelCommand, { id: a.id })).code).toBe(0)
      await workflows().resume(a.id)
      await workflows().resume('list:b')
      expect((await command(WorkflowPruneCommand, { olderThan: '1d' })).out).toContain('Deleted 0')
      t.clock.advance('2d')
      expect((await command(WorkflowPruneCommand, { olderThan: '1d' })).out).toContain('Deleted 2')
      expect(await run(a.id)).toBeNull()
      expect(await workflows().store.journal(a.id)).toEqual([]) // the journal went with it
    })

    test('a span per step that runs (not per replay); audit entries for starts and ends', async () => {
      const tracer = new BasicTracer()
      t.swap(Tracer, tracer)
      const recorded: string[] = []
      const workflows_ = workflows()
      workflows_.audit = { record: (action, { subject }) => recorded.push(`${action} ${subject.id}`) }
      try {
        knobs.failures = 1
        const { id } = await FlakyWorkflow.start({ tries: 2 }, { id: 'traced' })
        await t.workflows.runUntilIdle()
        const spans = tracer.finished.filter((s) => s.name.startsWith('workflow.step'))
        expect(spans.map((s) => [s.name, s.attributes['cslug.workflow.attempt'], s.status])).toEqual([
          ['workflow.step flaky', 1, 'error'],
          ['workflow.step flaky', 2, 'ok'],
        ])
        expect(spans[0]?.attributes['cslug.workflow.run_id']).toBe(id)
        expect(recorded).toEqual(['workflow.started traced', 'workflow.completed traced'])
      } finally {
        workflows_.audit = undefined
      }
    })

    test('WorkflowFake.runUntilIdle: sleeps and timeouts fast-forwarded; a run waiting without timeout is left', async () => {
      const start = t.clock.now().getTime()
      const { id } = await OrderWorkflow.start({ orderId: 'f1' })
      await t.workflows.runUntilIdle()
      await t.workflows.assertStatus(id, 'completed', { outcome: 'expired' })
      expect(t.clock.now().getTime() - start).toBe(4 * 86_400_000) // 1 day asleep + 3 days waiting

      saga.confirmFails = false
      const waiting = await BookingSaga.start({ bookingId: 'f2' })
      await t.workflows.runUntilIdle()
      await t.workflows.assertStatus(waiting.id, 'waiting') // for "go", without a timeout
      await t.workflows.signal(waiting.id, 'go')
      await t.workflows.runUntilIdle()
      await t.workflows.assertStatus(waiting.id, 'completed', 'done')
      await expect(t.workflows.assertStatus(waiting.id, 'failed')).rejects.toThrow('to be failed, got completed')
    })

    test('cslug describe workflows', async () => {
      const section = t.app.tagged<DescribeSection>(DESCRIBE).find((s) => s.name === 'workflows') as DescribeSection
      const rows = (await section.collect()) as { name: string; class: string; waitsFor: string }[]
      expect(rows.find((r) => r.name === 'fixture.order')).toEqual({
        name: 'fixture.order',
        class: 'OrderWorkflow',
        waitsFor: 'order.paid',
      })
    })
  })
})
