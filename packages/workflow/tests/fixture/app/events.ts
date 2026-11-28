import { Event } from '@cslug/core'

export class OrderPaid extends Event<{ orderId: string; amount: bigint }>('order.paid') {}
