import { expect } from 'bun:test'
import { type AnyEventClass, type Application, EventBus, type EventClass, Logger } from '@cslug/core'

/** Fakes available as `t.<name>`; packages add theirs with module augmentation and `registerFake`. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by packages
export interface TestFakes {}

export type FakeInstaller = (app: Application) => unknown
const installers = new Map<string, FakeInstaller>()

/** Packages register their fake: `registerFake('queue', (app) => { const f = new QueueFake(); app.swap(Queue, f); return f })`. */
export function registerFake(name: string, install: FakeInstaller): void {
  installers.set(name, install)
}
export const fakeInstaller = (name: string) => installers.get(name)

/** Fakes of optional packages, loaded on first use (the package may not be installed). */
const lazy: Record<string, () => Promise<FakeInstaller>> = {
  queue: async () => (await import('@cslug/queue')).installQueueFake,
  mail: async () => (await import('@cslug/mail')).installMailFake,
  storage: async () => (await import('@cslug/storage')).installStorageFake,
}

/** The installer for `name`: registered, or loaded from its package. Undefined if neither. */
export async function loadFake(name: string): Promise<FakeInstaller | undefined> {
  const known = installers.get(name)
  if (known || !lazy[name]) return known
  try {
    const install = await (lazy[name] as () => Promise<FakeInstaller>)()
    installers.set(name, install)
    return install
  } catch {
    return undefined
  }
}

type Recorded = { event: AnyEventClass; payload: unknown }

/** Records emitted events instead of running listeners. */
export class EventFake extends EventBus {
  readonly emitted: Recorded[] = []

  constructor(app: Application) {
    super(app, Logger.null())
  }

  override async emit<P>(event: EventClass<P>, payload: P): Promise<void> {
    this.emitted.push({ event, payload })
  }

  /** Emitted events of one class (payloads). */
  of<P>(event: EventClass<P>): P[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload as P)
  }

  assertEmitted<P>(event: EventClass<P>, predicate?: (e: { payload: P }) => boolean): void {
    const matching = this.of(event).filter((payload) => !predicate || predicate({ payload }))
    expect(
      matching.length,
      `expected ${event.eventName} to be emitted${predicate ? ' (matching the predicate)' : ''}`,
    ).toBeGreaterThan(0)
  }

  assertNotEmitted<P>(event: EventClass<P>): void {
    expect(this.of(event).length, `expected ${event.eventName} not to be emitted`).toBe(0)
  }

  assertNothingEmitted(): void {
    expect(this.emitted.map((e) => e.event.eventName)).toEqual([])
  }
}

registerFake('events', (app) => {
  const fake = new EventFake(app)
  app.swap(EventBus, fake)
  return fake
})

declare module './fakes' {
  interface TestFakes {
    events: EventFake
    queue: import('@cslug/queue').QueueFake
    mail: import('@cslug/mail').MailFake
    storage: import('@cslug/storage').StorageFake
  }
}
