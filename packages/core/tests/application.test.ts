import { afterEach, describe, expect, test } from 'bun:test'
import { Application, currentApp, inject, ProviderError, resolve, ServiceProvider, sortProviders } from '../src'

const log: string[] = []
/** The rejection reason of a promise that must fail. */
const rejection = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}
afterEach(() => {
  log.length = 0
})

// providers written exactly as guide 03 shows them (no `override` anywhere)
class DatabaseProvider extends ServiceProvider {
  register() {
    log.push('register db')
  }
  async boot() {
    log.push('boot db')
  }
  async shutdown() {
    log.push('shutdown db')
  }
}
abstract class PaymentGateway {
  abstract pay(): string
}
class FakePaymentGateway extends PaymentGateway {
  pay() {
    return 'paid'
  }
}
class PaymentServiceProvider extends ServiceProvider {
  static dependsOn = [DatabaseProvider]
  register() {
    log.push('register payments')
    this.app.singleton(PaymentGateway, FakePaymentGateway)
  }
  boot() {
    log.push(`boot payments (${this.app.resolve(PaymentGateway).pay()})`)
  }
  shutdown() {
    log.push('shutdown payments')
  }
}

describe('start / shutdown', () => {
  test('register all, then boot in dependency order; shutdown in reverse', async () => {
    const app = new Application().useProviders([PaymentServiceProvider, DatabaseProvider])
    await app.start()
    expect(log).toEqual(['register db', 'register payments', 'boot db', 'boot payments (paid)'])
    expect(app.isRunning).toBe(true)
    expect(currentApp()).toBe(app)
    await app.shutdown()
    expect(log.slice(4)).toEqual(['shutdown payments', 'shutdown db'])
    await app.shutdown() // idempotent
    expect(() => currentApp()).toThrow()
  })

  test('the app resolves itself; resolve() works after start', async () => {
    @inject(Application)
    class NeedsApp {
      constructor(readonly app: Application) {}
    }
    const app = await new Application({ root: '/srv/demo' }).start()
    expect(app.resolve(NeedsApp).app).toBe(app)
    expect(resolve(NeedsApp).app.rootDir).toBe('/srv/demo')
    await app.shutdown()
  })

  test('a failing boot rolls back providers that already booted, then rethrows', async () => {
    class Broken extends ServiceProvider {
      static dependsOn = [DatabaseProvider]
      boot() {
        throw new Error('cannot reach payment partner')
      }
    }
    const app = new Application().useProviders([DatabaseProvider, Broken])
    const error = (await rejection(app.start())) as ProviderError
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.message).toBe('Broken.boot() failed: cannot reach payment partner')
    expect((error.cause as Error).message).toBe('cannot reach payment partner')
    expect(log).toEqual(['register db', 'boot db', 'shutdown db'])
  })

  test('resolving during register() is a clear error', async () => {
    class Eager extends ServiceProvider {
      register() {
        this.app.resolve(PaymentGateway)
      }
    }
    await expect(new Application().useProviders([Eager]).start()).rejects.toThrow(
      /Cannot resolve PaymentGateway during register\(\)/,
    )
  })

  test('shutdown errors are collected, every provider still shuts down', async () => {
    class A extends ServiceProvider {
      shutdown() {
        log.push('a')
        throw new Error('a failed')
      }
    }
    class B extends ServiceProvider {
      static dependsOn = [A]
      shutdown() {
        log.push('b')
        throw new Error('b failed')
      }
    }
    const app = await new Application().useProviders([A, B]).start()
    const e = (await rejection(app.shutdown())) as AggregateError
    expect(e).toBeInstanceOf(AggregateError)
    expect(e.errors.map((x: Error) => x.message)).toEqual(['b failed', 'a failed'])
    expect(log).toEqual(['b', 'a'])
  })
})

describe('provider ordering', () => {
  class A extends ServiceProvider {}
  class B extends ServiceProvider {
    static dependsOn = [A]
  }
  class C extends ServiceProvider {
    static dependsOn = [B]
  }

  test('listed order is kept where dependencies allow', () => {
    expect(sortProviders([C, B, A]).map((p) => p.name)).toEqual(['A', 'B', 'C'])
    class X extends ServiceProvider {}
    expect(sortProviders([X, A, B]).map((p) => p.name)).toEqual(['X', 'A', 'B'])
  })

  test('duplicates, missing dependencies and cycles fail with the names', () => {
    expect(() => sortProviders([A, A])).toThrow('A is listed twice in the providers.')
    expect(() => sortProviders([B])).toThrow(
      'B depends on A, which is not in the provider list (bootstrap/providers.ts).',
    )
    class P extends ServiceProvider {
      static dependsOn: (typeof ServiceProvider & { dependsOn?: unknown })[] = []
    }
    class Q extends ServiceProvider {
      static dependsOn = [P]
    }
    P.dependsOn = [Q]
    expect(() => sortProviders([P, Q] as never)).toThrow('Circular provider dependencies: P → Q → P.')
  })
})
