/** A worker process for the crash test: `bun crash-worker.ts <prefix>`. It takes a job and is SIGKILLed while running it. */
import { registerJob, Workers } from '../../src'
import { HangOnFirstAttemptJob, redisApp } from '../support'

registerJob(HangOnFirstAttemptJob)
const app = redisApp(process.argv[2] as string)
await app.start()
await app.resolve(Workers).start([{ name: 'default', concurrency: 1 }])
