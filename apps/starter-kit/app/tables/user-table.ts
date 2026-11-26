import { table, id, text, timestamp, timestamps, type Row } from '@cslug/database'

export const users = table('users', {
  id: id(),
  name: text(),
  email: text().unique(),
  passwordHash: text(),
  locale: text().oneOf(['en', 'fr']).default('en'),
  emailVerifiedAt: timestamp().nullable(),
  ...timestamps(),
})

export type User = Row<typeof users>
