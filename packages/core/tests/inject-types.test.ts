/**
 * Compile-time contract of @inject: `bun run typecheck` fails if any @ts-expect-error below stops being an error.
 */
import { expect, test } from 'bun:test'
import { inject, token } from '../src'

class Database {
  query() {}
}
class Logger {
  info() {}
}
abstract class PaymentGateway {
  abstract pay(): void
}
const COMMISSION = token<number>('commission')

// ✓ matches the constructor
@inject(Database, PaymentGateway, COMMISSION)
class Good {
  constructor(
    readonly db: Database,
    readonly gateway: PaymentGateway,
    readonly pct: number,
  ) {}
}

// ✗ a dependency is missing
// @ts-expect-error: PaymentGateway is not listed
@inject(Database)
class Missing {
  constructor(
    readonly db: Database,
    readonly gateway: PaymentGateway,
  ) {}
}

// ✗ wrong order
// @ts-expect-error: the list must follow the constructor order
@inject(Logger, Database)
class WrongOrder {
  constructor(
    readonly db: Database,
    readonly log: Logger,
  ) {}
}

// ✗ a token of the wrong type
// @ts-expect-error: COMMISSION is a number token, the parameter is a string
@inject(COMMISSION)
class WrongToken {
  constructor(readonly name: string) {}
}

test('decorated classes still work at runtime', () => {
  expect([Good, Missing, WrongOrder, WrongToken].map((c) => c.name)).toEqual([
    'Good',
    'Missing',
    'WrongOrder',
    'WrongToken',
  ])
})
