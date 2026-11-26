import type { Container } from './container'
import { afterCommit, currentApp, currentContext, runInContext } from './context'
import { Logger } from './logger'
import type { Class } from './token'

/** A listener function for an event's payload. */
export type EventHandler<P> = (payload: P, event: EventInstance<P>) => unknown

export interface EventInstance<P> {
  readonly payload: P
}

/** The class an `Event<P>(name)` call produces. */
export interface EventClass<P = unknown> {
  readonly eventName: string
  new (payload: P): EventInstance<P>
}

/** Any event class, whatever its payload (for storage and registries). */
export type AnyEventClass = { readonly eventName: string; new (payload: never): EventInstance<unknown> }

/**
 * Define an event: a small typed class with a dot.case, past-tense name.
 *
 * ```ts
 * export class BookingDepositPaid extends Event<{ bookingId: string; amount: Money }>('booking.deposit_paid') {}
 * await BookingDepositPaid.emit({ bookingId, amount })
 * BookingDepositPaid.on(({ bookingId }) => metrics.increment('deposits'))
 * ```
 */
export function Event<P>(name: string) {
  return class CslugEvent implements EventInstance<P> {
    static readonly eventName = name
    constructor(readonly payload: P) {}

    /** Emit on the current application's event bus. */
    static emit<T extends EventClass<P>>(this: T, payload: P): Promise<void> {
      // biome-ignore lint/complexity/noThisInStatic: `this` is the concrete event subclass (e.g. BookingDepositPaid), not CslugEvent
      return currentApp().resolve(EventBus).emit(this, payload)
    }

    /** Listen with a function; returns a function that removes the listener. */
    static on<T extends EventClass<P>>(this: T, handler: EventHandler<P>): () => void {
      // biome-ignore lint/complexity/noThisInStatic: `this` is the concrete event subclass, not CslugEvent
      return currentApp().resolve(EventBus).on(this, handler)
    }
  }
}

export type ListenerOptions = {
  /** Run as a job (through @cslug/queue when installed), after the current transaction commits. */
  queued?: boolean
  /** Queue options (queue name, tries, backoff), passed to the queue dispatcher. */
  queue?: string
  tries?: number
  backoff?: unknown
}

type Registered = { cls: Class; options: ListenerOptions }
const classListeners = new Map<AnyEventClass, Registered[]>()

/**
 * Mark a class as a listener. It is built by the container (so it can have `@inject` dependencies) and its
 * `handle(payload, event)` is called. The order of `@inject` and `@listener` does not matter.
 *
 * ```ts
 * @inject(BadgeService)
 * @listener(OperatorVerified, { queued: true })
 * export class UpdateReliabilityBadgeListener {
 *   constructor(private badges: BadgeService) {}
 *   async handle({ operatorId }: OperatorVerified['payload']) { … }
 * }
 * ```
 */
export function listener(events: AnyEventClass | readonly AnyEventClass[], options: ListenerOptions = {}) {
  return <C extends Class<{ handle(payload: never, event: never): unknown }>>(
    target: C,
    context: ClassDecoratorContext<C>,
  ) => {
    if (context.kind !== 'class') throw new TypeError('@listener can only decorate a class')
    for (const e of Array.isArray(events) ? events : [events]) {
      classListeners.set(e, [...(classListeners.get(e) ?? []), { cls: target, options }])
    }
  }
}

/** Listener classes registered with `@listener` (for `cslug events` and the queue). */
export function registeredListeners(): ReadonlyMap<AnyEventClass, readonly Registered[]> {
  return classListeners
}

/** What @cslug/queue provides to run queued listeners as jobs. */
export type QueuedListenerDispatcher = (job: {
  listener: Class
  event: AnyEventClass
  payload: unknown
  options: ListenerOptions
}) => Promise<void> | void

type Handle = { handle(payload: unknown, event: EventInstance<unknown>): unknown }

/**
 * The application's event bus (a singleton). Synchronous listeners run in order inside the emitter's context and
 * transaction; an error propagates to the emitter. Queued listeners run after the transaction commits.
 */
export class EventBus {
  private readonly closures = new Map<AnyEventClass, EventHandler<never>[]>()
  /** Set by @cslug/queue. Without it, queued listeners run in-process after commit. */
  dispatchQueued?: QueuedListenerDispatcher

  constructor(
    private readonly app: Container,
    private readonly log: Logger = Logger.null(),
  ) {}

  on<P>(event: EventClass<P>, handler: EventHandler<P>): () => void {
    const list = [...(this.closures.get(event) ?? []), handler as EventHandler<never>]
    this.closures.set(event, list)
    return () => {
      this.closures.set(
        event,
        (this.closures.get(event) ?? []).filter((h) => h !== handler),
      )
    }
  }

  async emit<P>(event: EventClass<P>, payload: P): Promise<void> {
    const instance = new event(payload)
    for (const handler of this.closures.get(event) ?? []) await (handler as EventHandler<P>)(payload, instance)
    for (const { cls, options } of classListeners.get(event) ?? []) {
      if (options.queued) {
        afterCommit(() => this.runQueued(cls, event, payload, options))
        continue
      }
      const container = currentContext()?.scope ?? this.app
      await (container.resolve(cls) as Handle).handle(payload, instance as EventInstance<unknown>)
    }
  }

  private async runQueued(cls: Class, event: AnyEventClass, payload: unknown, options: ListenerOptions): Promise<void> {
    try {
      if (this.dispatchQueued) return await this.dispatchQueued({ listener: cls, event, payload, options })
      // no queue installed: run in-process, in a fresh scope, errors logged (the emitter has already returned)
      const scope = this.app.createScope()
      const ctx = currentContext()
      await runInContext(
        { ...(ctx ?? { app: currentApp() }), scope, tx: undefined } as Parameters<typeof runInContext>[0],
        async () => {
          try {
            await (scope.resolve(cls) as Handle).handle(payload, new event(payload as never))
          } finally {
            await scope.dispose()
          }
        },
      )
    } catch (error) {
      this.log.error(`Queued listener ${cls.name} failed for ${event.eventName}`, {
        error,
        listener: cls.name,
        event: event.eventName,
      })
    }
  }
}
