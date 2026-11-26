import { CslugError, registeredListeners, resolve } from '@cslug/core'
import { Job } from './job'

type Payload = { listener: string; event: string; payload: unknown }

/** Runs a `@listener(Event, { queued: true })` class in a worker. */
export class QueuedListenerJob extends Job<Payload> {
  static jobName = 'cslug.listener'

  async handle({ listener, event, payload }: Payload) {
    for (const [cls, list] of registeredListeners()) {
      if (cls.eventName !== event) continue
      const found = list.find((l) => l.cls.name === listener)
      if (!found) continue
      const instance = resolve(found.cls) as { handle(payload: unknown, event: unknown): unknown }
      return instance.handle(payload, new cls(payload as never))
    }
    throw new CslugError(
      'queue.listener_not_found',
      `No listener ${listener} for ${event}. Workers load app/listeners/; is the file there?`,
    )
  }
}
