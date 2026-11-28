import { AppError } from '@cslug/core'

export class PaymentDeclined extends AppError {
  constructor(readonly reason: string) {
    super('payments.declined', 'Payment declined', { status: 402 })
  }
}
