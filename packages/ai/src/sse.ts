import { currentContext, runInContext } from '@cslug/core'

/**
 * Stream text to the browser as server-sent events: `return sse(this.assistant.stream({ input }))`. Each piece of
 * text is a `data:` line (JSON string); the end is `event: done`, a failure `event: error`. The stream keeps the
 * request's context (user, scope) while the model answers.
 */
export function sse(text: AsyncIterable<string>) {
  const context = currentContext()
  const encoder = new TextEncoder()
  const iterator = text[Symbol.asyncIterator]()
  const next = () => (context ? runInContext(context, () => iterator.next()) : iterator.next())
  return {
    toResponse: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { value, done } = await next()
              if (done) {
                controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'))
                controller.close()
              } else controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message })}\n\n`))
              controller.close()
            }
          },
          cancel: () => void iterator.return?.(),
        }),
        { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } },
      ),
  }
}
