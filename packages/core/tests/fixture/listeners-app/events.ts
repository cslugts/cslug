import { Event } from '../../../src'

export class InvoicePaid extends Event<{ invoiceId: string }>('invoice.paid') {}

/** What the fixture's listeners saw. */
export const seen: string[] = []
