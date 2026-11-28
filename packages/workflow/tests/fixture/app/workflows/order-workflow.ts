import { inject } from '@cslug/core'
import { Database, sql } from '@cslug/database'
import { Workflow, type WorkflowContext } from '../../../../src'
import { OrderPaid } from '../events'

type Input = { orderId: string }

/** Test switches: how many attempts of `flaky` fail, and whether the code was "changed" under a running run. */
export const knobs = { failures: 0, changed: false, effectThenThrow: false }

@inject(Database)
export class OrderWorkflow extends Workflow<Input, { outcome: string; approved?: boolean }> {
  static workflowName = 'fixture.order'
  static waitsFor = [OrderPaid]

  constructor(private db: Database) {
    super()
  }

  private effect(runId: string, name: string) {
    return this.db.exec(sql`insert into effects (id, run_id, name) values (${Bun.randomUUIDv7()}, ${runId}, ${name})`)
  }

  async run(ctx: WorkflowContext, { orderId }: Input) {
    const reservation = await ctx.step(knobs.changed ? 'reserve-v2' : 'reserve', async () => {
      await this.effect(ctx.runId, 'reserve')
      return { reservation: `r-${orderId}`, at: new Date('2027-01-01T00:00:00Z'), cents: 1200n }
    })
    await ctx.now()
    await ctx.uuid()
    await ctx.sleep('1d')
    const paid = await ctx.waitFor(OrderPaid, { orderId }, { timeout: '3d' })
    if (!paid) return { outcome: 'expired' }
    const decision = await ctx.waitForSignal<{ approved: boolean }>('approve', { timeout: '2d' })
    await ctx.step('ship', () => this.effect(ctx.runId, 'ship'))
    return { outcome: `shipped ${reservation.reservation} ${paid.amount}`, approved: decision?.approved }
  }
}

@inject(Database)
export class FlakyWorkflow extends Workflow<{ tries: number }, string> {
  static workflowName = 'fixture.flaky'

  constructor(private db: Database) {
    super()
  }

  async run(ctx: WorkflowContext, { tries }: { tries: number }) {
    return ctx.step(
      'flaky',
      async () => {
        await this.db.exec(
          sql`insert into effects (id, run_id, name) values (${Bun.randomUUIDv7()}, ${ctx.runId}, 'attempt')`,
        )
        if (knobs.failures > 0) {
          knobs.failures--
          throw new Error('gateway down')
        }
        return 'ok'
      },
      { tries, backoff: '1m' },
    )
  }
}
