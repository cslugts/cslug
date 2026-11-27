import { inject } from '@cslug/core'
import { v } from '@cslug/validation'
import { mcp, Tool } from '../../../../src'

/** Exposed to callers whose token has `mcp:bookings`. */
@inject()
@mcp({ ability: 'mcp:bookings' })
export class BookingStatusTool extends Tool {
  name = 'booking_status'
  description = 'The status of a booking by its reference.'
  input = v.object({ ref: v.string().min(3) })
  handle({ ref }: v.infer<this['input']>) {
    if (ref === 'BOOM') throw new Error('ledger unavailable')
    return { ref, status: 'deposit_paid' }
  }
}

/** Exposed to anyone. */
@inject()
@mcp({ public: true })
export class CircuitListTool extends Tool {
  name = 'circuits'
  description = 'The circuits on offer.'
  input = v.object({})
  handle() {
    return ['Isalo', 'Tsingy']
  }
}

/** Not exposed over MCP. */
@inject()
export class InternalTool extends Tool {
  name = 'internal'
  description = 'Not for MCP.'
  input = v.object({})
  handle() {
    return 'secret'
  }
}
