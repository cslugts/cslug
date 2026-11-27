import { inject } from '@cslug/core'
import { v } from '@cslug/validation'
import { Agent } from '../../../../src'

/** Found by `ai:eval` (app/agents) for the fixtures in tests/fixtures/ai/offers. */
@inject()
export class QuoteAgent extends Agent {
  model = 'claude-haiku-5-5'
  instructions = 'Read the price.'
  output = v.object({ price: v.int().min(1), currency: v.enum(['EUR', 'MGA']) })
}
