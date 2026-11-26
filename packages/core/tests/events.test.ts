import { afterEach, describe, expect, test } from 'bun:test'
import {
  Application,
  Event,
  EventBus,
  inject,
  Logger,
  listener,
  Money,
  runInContext,
  type TransactionHooks,
} from '../src'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <_T extends true>() => {}
const tick = () => new Promise((r) => setTimeout(r, 5))

// ── guide 13, as written ──────────────────────────────────────────────────────────────────────────────
class BookingDepositPaid extends Event<{ bookingId: string; amount: Money }>('booking.deposit_paid') {}
class OperatorVerified extends Event<{ operatorId: string }>('operator.verified') {}
class ClaimOpened extends Event<{ claimId: string }>('claim.opened') {}
class ClaimEscalated extends Event<{ claimId: string }>('claim.escalated') {}

const recorded: string[] = []

@inject.singleton()
class BadgeService {
  async recompute(operatorId: string) {
    recorded.push(`badge ${operatorId}`)
  }
}

@inject(BadgeService)
@listener(OperatorVerified, { queued: true })
class UpdateReliabilityBadgeListener {
  constructor(private badges: BadgeService) {}
  async handle({ operatorId }: OperatorVerified['payload']) {
    await this.badges.recompute(operatorId)
  }
}

@listener([ClaimOpened, ClaimEscalated])
@inject()
class NotifyStaffListener {
  handle({ claimId }: ClaimOpened['payload']) {
    recorded.push(`staff ${claimId}`)
  }
}

// listener classes register themselves through their decorators
void [UpdateReliabilityBadgeListener, NotifyStaffListener]

let app: Application
afterEach(async () => {
  recorded.length = 0
  await app?.shutdown()
})
const start = async () => {
  app = await new Application().start()
  return app
}

describe('events', () => {
  test('the payload is typed on the event and on the instance', () => {
    assertType<Equal<OperatorVerified['payload'], { operatorId: string }>>()
    assertType<Equal<Parameters<typeof BookingDepositPaid.emit>[0], { bookingId: string; amount: Money }>>()
    expect(BookingDepositPaid.eventName).toBe('booking.deposit_paid')
  })

  test('closure listeners, in order; on() returns an unsubscribe', async () => {
    await start()
    const off = BookingDepositPaid.on(({ bookingId, amount }) => {
      recorded.push(`a ${bookingId} ${amount.toDecimal()}`)
    })
    BookingDepositPaid.on(() => {
      recorded.push('b')
    })
    await BookingDepositPaid.emit({ bookingId: 'b1', amount: Money.of(66000n, 'EUR') })
    off()
    await BookingDepositPaid.emit({ bookingId: 'b2', amount: Money.of(1n, 'EUR') })
    expect(recorded).toEqual(['a b1 660.00', 'b', 'b'])
  })

  test('a class listener for several events, with either decorator order', async () => {
    await start()
    await ClaimOpened.emit({ claimId: 'c1' })
    await ClaimEscalated.emit({ claimId: 'c1' })
    expect(recorded).toEqual(['staff c1', 'staff c1'])
  })

  test('a synchronous listener error reaches the emitter (so it can roll the transaction back)', async () => {
    await start()
    class Failing extends Event<{ n: number }>('test.failing') {}
    Failing.on(() => {
      throw new Error('listener failed')
    })
    await expect(Failing.emit({ n: 1 })).rejects.toThrow('listener failed')
  })

  test('queued listeners run after the emitter returned, with DI, in their own scope', async () => {
    await start()
    await OperatorVerified.emit({ operatorId: 'op1' })
    expect(recorded).toEqual([]) // not yet
    await tick()
    expect(recorded).toEqual(['badge op1'])
  })

  test('queued listeners wait for the transaction to commit (and never run on rollback)', async () => {
    await start()
    const committed: (() => unknown)[] = []
    const tx: TransactionHooks = { afterCommit: (fn) => committed.push(fn) }
    await runInContext({ app, scope: app.createScope(), tx }, () => OperatorVerified.emit({ operatorId: 'op2' }))
    await tick()
    expect(recorded).toEqual([]) // held by the transaction
    for (const fn of committed) await fn()
    expect(recorded).toEqual(['badge op2'])
  })

  test('with @cslug/queue installed, queued listeners go to its dispatcher', async () => {
    await start()
    const jobs: string[] = []
    app.resolve(EventBus).dispatchQueued = ({ listener: cls, event, payload, options }) => {
      jobs.push(`${cls.name} ${event.eventName} ${JSON.stringify(payload)} queued=${options.queued}`)
    }
    await OperatorVerified.emit({ operatorId: 'op3' })
    await tick()
    expect(jobs).toEqual(['UpdateReliabilityBadgeListener operator.verified {"operatorId":"op3"} queued=true'])
    expect(recorded).toEqual([])
  })

  test('a failing queued listener is logged, not thrown at the emitter', async () => {
    const lines: string[] = []
    app = new Application()
    app.swap(Logger, new Logger({ write: (l) => lines.push(l) }))
    await app.start()
    class Flaky extends Event<{ id: string }>('test.flaky') {}
    @listener(Flaky, { queued: true })
    @inject()
    class FlakyListener {
      handle() {
        throw new Error('partner API down')
      }
    }
    void FlakyListener
    await Flaky.emit({ id: 'x' })
    await tick()
    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry).toMatchObject({
      level: 'error',
      msg: 'Queued listener FlakyListener failed for test.flaky',
      listener: 'FlakyListener',
    })
    expect(entry.error.message).toBe('partner API down')
  })
})
