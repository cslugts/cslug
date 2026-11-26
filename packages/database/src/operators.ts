import { type SqlFragment, sql } from './sql'

/** A condition on one column, built by the operator helpers below. */
export class Op<T = unknown> {
  declare readonly _type: T
  constructor(readonly render: (column: unknown) => SqlFragment<unknown>) {}
}

export const eq = <T>(v: T) => new Op<T>((c) => sql`${c} = ${v}`)
export const ne = <T>(v: T) => new Op<T>((c) => sql`${c} <> ${v}`)
export const gt = <T>(v: T) => new Op<T>((c) => sql`${c} > ${v}`)
export const gte = <T>(v: T) => new Op<T>((c) => sql`${c} >= ${v}`)
export const lt = <T>(v: T) => new Op<T>((c) => sql`${c} < ${v}`)
export const lte = <T>(v: T) => new Op<T>((c) => sql`${c} <= ${v}`)
export const between = <T>(from: T, to: T) => new Op<T>((c) => sql`${c} between ${from} and ${to}`)
/** `in (…)`; an empty list matches nothing (instead of being a syntax error). */
export const inList = <T>(values: readonly T[]) =>
  new Op<T>((c) => (values.length ? sql`${c} in (${sql.join(values)})` : sql`false`))
export const notIn = <T>(values: readonly T[]) =>
  new Op<T>((c) => (values.length ? sql`${c} not in (${sql.join(values)})` : sql`true`))
export const like = (pattern: string) => new Op<string>((c) => sql`${c} like ${pattern}`)
export const ilike = (pattern: string) => new Op<string>((c) => sql`${c} ilike ${pattern}`)
// biome-ignore lint/suspicious/noExplicitAny: matches any column type
export const isNull = () => new Op<any>((c) => sql`${c} is null`)
// biome-ignore lint/suspicious/noExplicitAny: matches any column type
export const notNull = () => new Op<any>((c) => sql`${c} is not null`)
/** Negate an operator: `not(inList(['a', 'b']))`. */
export const not = <T>(op: Op<T>) => new Op<T>((c) => sql`not (${op.render(c)})`)
