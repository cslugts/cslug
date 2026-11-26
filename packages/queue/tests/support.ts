import { Application, currentContext, Event, inject, Logger, listener } from '@cslug/core'
import { Redis, RedisProvider } from '@cslug/redis'
import { v } from '@cslug/validation'
import { Job, QueueProvider } from '../src'

export const REDIS_URL = process.env.REDIS_URL
export const DATABASE_URL = process.env.DATABASE_URL

/** What the test jobs did, in order. */
export const runs: { job: string; payload: unknown; attempt?: unknown }[] = []
export const reset = () => {
  runs.length = 0
  failures.length = 0
}
export const failures: { payload: unknown; error: string }[] = []

/** Records where tests can see it. */
@inject()
export class Recorder {
  record(job: string, payload: unknown) {
    runs.push({ job, payload })
  }
}

@inject(Recorder)
export class RecordJob extends Job<{ n: number; at?: Date; big?: bigint }> {
  constructor(private recorder: Recorder) {
    super()
  }
  handle(payload: { n: number; at?: Date; big?: bigint }) {
    this.recorder.record('record', payload)
  }
}

export class FailingJob extends Job<{ n: number }> {
  static tries = 3
  static backoff = 0
  handle(payload: { n: number }): void {
    runs.push({ job: 'failing', payload })
    throw new Error(`boom ${payload.n}`)
  }
  failed(payload: { n: number }, error: Error) {
    failures.push({ payload, error: error.message })
  }
}

export class SlowJob extends Job<{ ms: number }> {
  static timeout = '150ms'
  static tries = 1
  async handle({ ms }: { ms: number }) {
    await Bun.sleep(ms)
    runs.push({ job: 'slow', payload: { ms } })
  }
}

export class ChainingJob extends Job<{ depth: number }> {
  async handle({ depth }: { depth: number }) {
    runs.push({ job: 'chaining', payload: { depth } })
    if (depth > 0) await ChainingJob.dispatch({ depth: depth - 1 })
  }
}

export class ValidatedJob extends Job.schema(v.object({ eventId: v.string() })) {
  handle(payload: { eventId: string }) {
    runs.push({ job: 'validated', payload })
  }
}

export class NoPayloadJob extends Job {
  handle() {
    runs.push({ job: 'no-payload', payload: undefined })
  }
}

export class TodoCompleted extends Event<{ todoId: string }>('todo.completed') {}

@inject()
@listener(TodoCompleted, { queued: true, queue: 'listeners' })
export class CountCompletedListener {
  handle({ todoId }: { todoId: string }) {
    runs.push({ job: 'listener', payload: { todoId } })
  }
}

/** A unique key prefix per test file, so tests never see each other's keys. */
export const prefix = () => `cslug-qtest:${process.pid}:${Math.random().toString(36).slice(2, 8)}:`

/** An app on real Redis with short leases and reads, so tests run fast. */
export function redisApp(keyPrefix: string, queue: Record<string, unknown> = {}): Application {
  const app = new Application({
    configs: {
      redis: { connections: { default: { url: REDIS_URL } }, prefix: keyPrefix },
      queue: { lease: '600ms', block: '50ms', shutdownTimeout: '2s', ...queue },
    },
  }).useProviders([RedisProvider, QueueProvider])
  app.singleton(Logger, () => Logger.null())
  return app
}

/** Delete every key under the prefix. */
export async function cleanRedis(keyPrefix: string): Promise<void> {
  const redis = new Redis(REDIS_URL as string, keyPrefix)
  const keys: string[] = []
  for await (const k of redis.scan('*')) keys.push(k)
  if (keys.length) await redis.send('DEL', keys)
  redis.close()
}

/** Wait until `check()` is true (polling), or fail after `ms`. */
export async function until(check: () => boolean | Promise<boolean>, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Hangs on its first attempt (the crash test kills that worker), records later ones with their attempt number. */
export class HangOnFirstAttemptJob extends Job<{ n: number }> {
  static timeout = '1m'
  async handle(payload: { n: number }) {
    const attempt = currentContext()?.attempt
    if (attempt === 1) {
      process.stdout.write('started\n')
      await new Promise(() => {}) // the test SIGKILLs this process
    }
    runs.push({ job: 'hang', payload, attempt })
  }
}
