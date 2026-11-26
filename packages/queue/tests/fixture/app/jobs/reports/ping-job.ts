import { Job } from '../../../../../src'

/** Found by discovery in a subfolder. */
export class PingJob extends Job<{ n: number }> {
  static jobName = 'fixture.ping'
  handle({ n }: { n: number }) {
    ;(globalThis as { pinged?: number[] }).pinged = [...((globalThis as { pinged?: number[] }).pinged ?? []), n]
  }
}
