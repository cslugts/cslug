import { expect, test } from 'bun:test'
import { v } from '../src'

test('JSON Schema export for AI tools, OpenAPI and `cslug describe`', () => {
  const Offer = v.object({
    price: v.money({ currencies: ['EUR', 'USD'] }),
    seats: v.int().min(1).max(12).describe('Seats in the vehicle'),
    guideLanguages: v.array(v.enum(['fr', 'en', 'it'])).max(3),
    nightDriving: v.boolean().default(false),
    notes: v.string().max(500).optional(),
    startDate: v.date(),
    contact: v.email().nullable(),
  })
  expect(Offer.toJSONSchema()).toEqual({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      price: {
        type: 'object',
        properties: {
          amount: { type: ['string', 'integer'], pattern: '^-?\\d+$' },
          currency: { type: 'string', enum: ['EUR', 'USD'] },
        },
        required: ['amount', 'currency'],
        additionalProperties: false,
        description: 'Amount in minor units (e.g. cents) and ISO 4217 currency',
      },
      seats: { type: 'integer', minimum: 1, maximum: 12, description: 'Seats in the vehicle' },
      guideLanguages: { type: 'array', items: { type: 'string', enum: ['fr', 'en', 'it'] }, maxItems: 3 },
      nightDriving: { type: 'boolean', default: false },
      notes: { type: 'string', maxLength: 500 },
      startDate: { type: 'string', format: 'date' },
      contact: { anyOf: [{ type: 'string', format: 'email' }, { type: 'null' }] },
    },
    required: ['price', 'seats', 'guideLanguages', 'startDate', 'contact'],
    additionalProperties: false,
  })
})
