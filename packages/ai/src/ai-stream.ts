import type { AiResult } from './ai'

type StreamStep = { type: 'text'; text: string } | { type: 'result'; result: AiResult }

/**
 * What `stream()` returns: the text as it arrives (`for await`, or `sse(stream)`), and `result`, the finished run
 * with its `messages` to store for the next turn. `result` settles once the text has been read to the end (it
 * rejects with the run's error).
 */
export class AiStream<V = unknown> implements AsyncIterable<string> {
  readonly result: Promise<AiResult<V>>
  private settle!: { resolve(result: AiResult<V>): void; reject(error: unknown): void }

  constructor(private readonly steps: AsyncIterable<StreamStep>) {
    this.result = new Promise((resolve, reject) => {
      this.settle = { resolve, reject }
    })
    this.result.catch(() => {}) // the error also reaches the reader of the text; not unhandled when nobody awaits
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    try {
      for await (const step of this.steps)
        if (step.type === 'text') yield step.text
        else this.settle.resolve(step.result as AiResult<V>)
    } catch (error) {
      this.settle.reject(error)
      throw error
    }
  }
}
