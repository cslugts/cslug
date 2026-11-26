import { Job } from '../../../../../src'

/** Not a job module: discovery skips *.test.ts (it would count 2 jobs otherwise). bun test loads it as an empty test file. */
export class DecoyJob extends Job {
  handle() {}
}
