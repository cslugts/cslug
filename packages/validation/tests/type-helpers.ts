/** Compile-time assertions: `assertType<Equal<A, B>>()` fails `tsc` if A and B differ. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
export const assertType = <_T extends true>() => {}

import { expect } from 'bun:test'
import { ValidationError } from '../src'

/** Run `fn`, expect a ValidationError, return its `errors` map. */
export function errorsOf(fn: () => unknown): Record<string, string[]> {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    return (e as ValidationError).errors
  }
  throw new Error('expected a ValidationError')
}

export async function errorsOfAsync(fn: () => Promise<unknown>): Promise<Record<string, string[]>> {
  try {
    await fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    return (e as ValidationError).errors
  }
  throw new Error('expected a ValidationError')
}
