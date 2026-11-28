import { inject } from '@cslug/core'
import { ErrorHandler } from '../../../../../src'
import { PaymentDeclined } from '../../../errors'

/** Found in a subfolder of app/exceptions/, never imported by the app's own code. */
@inject()
export class PaymentDeclinedHandler extends ErrorHandler<PaymentDeclined> {
  static handles = [PaymentDeclined]
  html(error: PaymentDeclined) {
    return new Response(`<p>Declined: ${error.reason}</p>`, { status: 402, headers: { 'content-type': 'text/html' } })
  }
  json(error: PaymentDeclined) {
    return { code: 'payments.declined', reason: error.reason }
  }
}
