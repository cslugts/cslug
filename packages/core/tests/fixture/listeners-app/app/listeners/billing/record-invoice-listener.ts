import { inject, listener } from '../../../../../../src'
import { InvoicePaid, seen } from '../../../events'

/** A synchronous listener in a subfolder of app/listeners/, never imported by the app's own code. */
@inject()
@listener(InvoicePaid)
export class RecordInvoiceListener {
  handle({ invoiceId }: InvoicePaid['payload']) {
    seen.push(invoiceId)
  }
}
