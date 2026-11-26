/** Any class, including abstract classes (used as interfaces). */
// biome-ignore lint/suspicious/noExplicitAny: constructor parameters of arbitrary classes
export type Class<T = unknown> = abstract new (...args: any[]) => T

/** A named token for a value that is not a class instance (a number, a string, a config object…). */
export class InjectionToken<T> {
  declare readonly __type: T
  constructor(readonly name: string) {}
  toString() {
    return `token(${this.name})`
  }
}

/** Something the container can resolve. */
export type Token<T = unknown> = Class<T> | InjectionToken<T>

/** The type a token resolves to. */
export type Resolved<K> = K extends InjectionToken<infer V> ? V : K extends Class<infer I> ? I : never

/** `export const COMMISSION_PERCENT = token<number>('payments.commission_percent')` */
export const token = <T>(name: string): InjectionToken<T> => new InjectionToken<T>(name)

export const tokenName = (t: unknown): string =>
  t instanceof InjectionToken ? t.toString() : typeof t === 'function' ? t.name || '(anonymous class)' : String(t)
