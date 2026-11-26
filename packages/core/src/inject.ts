import type { Class, Resolved, Token } from './token'

export type Lifetime = 'singleton' | 'scoped' | 'transient'
export type Injectable = { deps: readonly Token[]; lifetime: Lifetime }

const registry = new WeakMap<object, Injectable>()

/** The `@inject` registration of a class, inherited from the nearest decorated parent. */
export function injectable(target: object): Injectable | undefined {
  for (let c: object | null = target; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    const found = registry.get(c)
    if (found) return found
  }
  return undefined
}

type Decorator<D extends readonly Token[]> = <
  C extends abstract new (
    ...args: { [K in keyof D]: Resolved<D[K]> }
  ) => unknown,
>(
  target: C,
  context: ClassDecoratorContext<C>,
) => void

function decorator<const D extends readonly Token[]>(lifetime: Lifetime, deps: D): Decorator<D> {
  return (target, context) => {
    if (context.kind !== 'class') throw new TypeError('@inject can only decorate a class')
    deps.forEach((d, i) => {
      if (d === undefined || d === null) {
        throw new TypeError(
          `@inject on ${String(context.name)}: dependency #${i + 1} is ${d}. This is usually a circular import, or the dependency was imported with \`import type\`.`,
        )
      }
    })
    registry.set(target, { deps, lifetime })
  }
}

/**
 * Mark a class as buildable by the container and list its constructor dependencies, in order:
 *
 * ```ts
 * @inject(BookingRepository, EscrowService)
 * export class BookingController {
 *   constructor(private bookings: BookingRepository, private escrow: EscrowService) {}
 * }
 * ```
 *
 * The list is type-checked against the constructor (order and types). Instances are **scoped** (one per request,
 * job or command); use `@inject.singleton(...)` for one per application.
 */
export function inject<const D extends readonly Token[]>(...deps: D): Decorator<D> {
  return decorator('scoped', deps)
}

/** Like `@inject(...)`, but one instance per application. */
inject.singleton = <const D extends readonly Token[]>(...deps: D): Decorator<D> => decorator('singleton', deps)

/** Like `@inject(...)`, but a new instance every time it is resolved. */
inject.transient = <const D extends readonly Token[]>(...deps: D): Decorator<D> => decorator('transient', deps)

export type { Class }
