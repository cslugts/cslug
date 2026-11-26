import { Clock, currentApp, resolve } from '@cslug/core'
import { Database } from './database'
import { Fake } from './fake'
import { Repository } from './repository'
import type { NewRow, Row, Table } from './table'

export type FactoryContext = { seq: number; fake: Fake; clock: Clock }

/** Attribute values; a function is called at build time (and may be async, e.g. to create a parent row). */
export type FactoryValues<T extends Table> = {
  [K in keyof NewRow<T>]?: NewRow<T>[K] | (() => NewRow<T>[K] | Promise<NewRow<T>[K]>)
}
type Definition<T extends Table> = FactoryValues<T> | ((ctx: FactoryContext) => FactoryValues<T>)

const sequences = new Map<string, number>()
const fake = new Fake()

/**
 * Test data for a table:
 *
 * ```ts
 * export const OperatorFactory = factory(operators, ({ seq, fake }) => ({ companyName: `Operator ${seq}`, phone: fake.phone('MG') }))
 *   .state('verified', { verificationStatus: 'verified' })
 * await OperatorFactory.state('verified').createMany(12)
 * await TodoFactory.for({ userId: me.id }).create({ title: 'Buy bread' })
 * ```
 */
export class Factory<T extends Table> {
  constructor(
    readonly table: T,
    private readonly base: Definition<T>,
    private readonly states: ReadonlyMap<string, Definition<T>> = new Map(),
    private readonly applied: readonly Definition<T>[] = [],
    private readonly database?: Database,
  ) {}

  /** `state(name, values)` defines a state; `state(name)` applies it. States combine. */
  state(name: string, definition?: Definition<T>): Factory<T> {
    if (definition !== undefined) {
      return new Factory(
        this.table,
        this.base,
        new Map([...this.states, [name, definition]]),
        this.applied,
        this.database,
      )
    }
    const found = this.states.get(name)
    if (!found)
      throw new Error(
        `${this.table.name} factory has no state "${name}" (defined: ${[...this.states.keys()].join(', ') || 'none'})`,
      )
    return new Factory(this.table, this.base, this.states, [...this.applied, found], this.database)
  }

  /** Fixed attributes for every row: `.for({ userId: me.id })`. */
  for(values: FactoryValues<T>): Factory<T> {
    return new Factory(this.table, this.base, this.states, [...this.applied, values], this.database)
  }

  /** Use a specific database instead of the current app's. */
  on(db: Database): Factory<T> {
    return new Factory(this.table, this.base, this.states, this.applied, db)
  }

  /** Build the attributes without saving. */
  async make(overrides: FactoryValues<T> = {}): Promise<NewRow<T>> {
    const seq = (sequences.get(this.table.name) ?? 0) + 1
    sequences.set(this.table.name, seq)
    const ctx: FactoryContext = { seq, fake, clock: clockOrDefault() }
    const layers = [this.base, ...this.applied, overrides].map((d) => (typeof d === 'function' ? d(ctx) : d))
    const merged: Record<string, unknown> = Object.assign({}, ...layers)
    for (const [k, v] of Object.entries(merged)) if (typeof v === 'function') merged[k] = await (v as () => unknown)()
    return merged as NewRow<T>
  }

  async create(overrides: FactoryValues<T> = {}): Promise<Row<T>> {
    return this.repository().create(await this.make(overrides))
  }

  async createMany(count: number, overrides: FactoryValues<T> = {}): Promise<Row<T>[]> {
    const rows: Row<T>[] = []
    for (let i = 0; i < count; i++) rows.push(await this.create(overrides))
    return rows
  }

  private repository() {
    const db = this.database ?? resolve(Database)
    const Repo = Repository(this.table)
    const repo = Object.create((Repo as unknown as { prototype: object }).prototype) as InstanceType<typeof Repo>
    Object.assign(repo, { table: this.table, db })
    return repo
  }
}

const clockOrDefault = (): Clock => {
  try {
    return currentApp().resolve(Clock)
  } catch {
    return new Clock()
  }
}

export const factory = <T extends Table>(table: T, definition: Definition<T>) => new Factory(table, definition)

/** Seeders: `export default seeder(async () => { … })`, run by `cslug db:seed`. */
export const SEEDER: unique symbol = Symbol('cslug.seeder')
export type Seeder = { [SEEDER]: true; run: () => Promise<void> | void }
export const seeder = (run: () => Promise<void> | void): Seeder => ({ [SEEDER]: true, run })
export const isSeeder = (value: unknown): value is Seeder =>
  typeof value === 'object' && value !== null && SEEDER in value
