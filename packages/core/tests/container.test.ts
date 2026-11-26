import { describe, expect, test } from 'bun:test'
import {
  Application,
  BindingNotFoundError,
  CircularDependencyError,
  Container,
  inject,
  resolve,
  runInContext,
  ScopeViolationError,
  token,
} from '../src'

// a small domain, written the way guide 02 shows it
@inject.singleton()
class Database {
  id = Math.random()
}
abstract class PaymentGateway {
  abstract pay(): string
}
class MangopayGateway extends PaymentGateway {
  pay() {
    return 'mangopay'
  }
}
class FakeGateway extends PaymentGateway {
  pay() {
    return 'fake'
  }
}
@inject(Database)
class BookingRepository {
  constructor(readonly db: Database) {}
}
@inject(BookingRepository, PaymentGateway)
class EscrowService {
  constructor(
    readonly bookings: BookingRepository,
    readonly gateway: PaymentGateway,
  ) {}
}
const COMMISSION = token<number>('payments.commission_percent')
@inject(COMMISSION)
class PricingService {
  constructor(readonly commission: number) {}
}

const app = () => new Container().singleton(PaymentGateway, MangopayGateway)

describe('resolving', () => {
  test('@inject classes build without registration, deps included', () => {
    const escrow = app().resolve(EscrowService)
    expect(escrow.bookings.db).toBeInstanceOf(Database)
    expect(escrow.gateway.pay()).toBe('mangopay')
  })

  test('abstract classes are tokens bound to an implementation', () => {
    const c = new Container().singleton(PaymentGateway, FakeGateway)
    expect(c.resolve(PaymentGateway).pay()).toBe('fake')
  })

  test('value tokens', () => {
    const c = new Container().instance(COMMISSION, 8)
    expect(c.resolve(PricingService).commission).toBe(8)
  })

  test('factories receive the container', () => {
    const c = new Container().instance(COMMISSION, 8).singleton(PaymentGateway, (k) => {
      const pct = k.resolve(COMMISSION)
      return new (class extends PaymentGateway {
        pay() {
          return `fee ${pct}%`
        }
      })()
    })
    expect(c.resolve(PaymentGateway).pay()).toBe('fee 8%')
  })
})

describe('lifetimes and scopes', () => {
  test('singleton: one per application, shared by scopes', () => {
    const root = app()
    expect(root.createScope().resolve(Database)).toBe(root.createScope().resolve(Database))
  })

  test('scoped (default for @inject): one per scope', () => {
    const root = app()
    const a = root.createScope()
    const b = root.createScope()
    expect(a.resolve(BookingRepository)).toBe(a.resolve(BookingRepository))
    expect(a.resolve(BookingRepository)).not.toBe(b.resolve(BookingRepository))
    expect(a.resolve(BookingRepository).db).toBe(b.resolve(BookingRepository).db) // singleton dep shared
  })

  test('transient: new every time', () => {
    let n = 0
    const c = new Container().bind(COMMISSION, () => ++n)
    expect([c.resolve(COMMISSION), c.resolve(COMMISSION)]).toEqual([1, 2])
    @inject.transient()
    class Stamp {}
    expect(c.resolve(Stamp)).not.toBe(c.resolve(Stamp))
  })

  test('a singleton depending on a scoped class is refused', () => {
    @inject.singleton(BookingRepository)
    class Cache {
      constructor(readonly repo: BookingRepository) {}
    }
    expect(() => app().resolve(Cache)).toThrow(ScopeViolationError)
    expect(() => app().resolve(Cache)).toThrow(/Cache is a singleton but depends on BookingRepository, which is scoped/)
  })

  test('dispose calls Symbol.dispose / Symbol.asyncDispose on scoped instances', async () => {
    const log: string[] = []
    @inject()
    class Session {
      [Symbol.dispose]() {
        log.push('session disposed')
      }
    }
    @inject()
    class Tx {
      async [Symbol.asyncDispose]() {
        log.push('tx disposed')
      }
    }
    const scope = new Container().createScope()
    scope.resolve(Session)
    scope.resolve(Tx)
    await scope.dispose()
    expect(log).toEqual(['tx disposed', 'session disposed']) // reverse creation order
  })
})

describe('contextual, tagged, swap', () => {
  test('when(Consumer).needs(Token).give(Impl)', () => {
    @inject(PaymentGateway)
    class PublicController {
      constructor(readonly gateway: PaymentGateway) {}
    }
    const c = app().when(PublicController).needs(PaymentGateway).give(FakeGateway)
    expect(c.resolve(PublicController).gateway.pay()).toBe('fake')
    expect(c.resolve(EscrowService).gateway.pay()).toBe('mangopay') // others unaffected
  })

  test('tag / tagged', () => {
    @inject()
    class VisaCheck {
      name = 'visa'
    }
    @inject()
    class LicenceCheck {
      name = 'licence'
    }
    const c = new Container().tag([VisaCheck, LicenceCheck], 'compliance.checks')
    expect(c.tagged<{ name: string }>('compliance.checks').map((x) => x.name)).toEqual(['visa', 'licence'])
  })

  test('swap replaces a token for tests, restoreSwaps undoes it', () => {
    const c = app()
    c.swap(PaymentGateway, new FakeGateway())
    expect(c.createScope().resolve(EscrowService).gateway.pay()).toBe('fake')
    c.restoreSwaps()
    expect(c.createScope().resolve(EscrowService).gateway.pay()).toBe('mangopay')
  })
})

describe('errors say how to fix', () => {
  test('unbound abstract class: the chain and a hint', () => {
    @inject(EscrowService)
    class BookingController {
      constructor(readonly escrow: EscrowService) {}
    }
    const err = (() => {
      try {
        new Container().resolve(BookingController)
      } catch (e) {
        return e as Error
      }
    })()
    expect(err).toBeInstanceOf(BindingNotFoundError)
    expect(err?.message).toBe(
      [
        'Cannot resolve PaymentGateway',
        '  required by EscrowService',
        '  required by BookingController',
        '  Hint: if PaymentGateway is a class you wrote, add @inject(...) to it.',
        '        If it is abstract (an interface), bind an implementation in a provider:',
        '        this.app.singleton(PaymentGateway, YourPaymentGatewayImplementation)',
      ].join('\n'),
    )
  })

  test('unbound value token', () => {
    expect(() => new Container().resolve(PricingService)).toThrow(
      /Cannot resolve token\(payments\.commission_percent\)/,
    )
  })

  test('a class with constructor arguments but no @inject', () => {
    class Plain {
      constructor(readonly x: number) {}
    }
    expect(() => new Container().singleton(Plain).resolve(Plain)).toThrow(/has no @inject/)
  })

  test('circular factories are detected', () => {
    const A = token<unknown>('a')
    const B = token<unknown>('b')
    const c = new Container().singleton(A, (k) => k.resolve(B)).singleton(B, (k) => k.resolve(A))
    expect(() => c.resolve(A)).toThrow(CircularDependencyError)
    expect(() => c.resolve(A)).toThrow('Circular dependency: token(a) → token(b) → token(a)')
  })
})

describe('resolve(): field injection and ambient scope', () => {
  test('field initialisers resolve from the container building the object', () => {
    abstract class AdminController {
      protected db = resolve(Database)
      get dbId() {
        return this.db.id
      }
    }
    @inject(BookingRepository)
    class OperatorAdminController extends AdminController {
      constructor(readonly repo: BookingRepository) {
        super()
      }
    }
    const c = app()
    const ctl = c.resolve(OperatorAdminController)
    expect(ctl.dbId).toBe(c.resolve(Database).id)
  })

  test('inside a context, resolve() uses the current scope', () => {
    const application = new Application().singleton(PaymentGateway, MangopayGateway)
    const scope = application.createScope()
    const repo = runInContext({ app: application, scope }, () => resolve(BookingRepository))
    expect(repo).toBe(scope.resolve(BookingRepository))
  })

  test('outside any context and before start(), resolve() explains', () => {
    expect(() => resolve(Database)).toThrow(/No application is running/)
  })
})
