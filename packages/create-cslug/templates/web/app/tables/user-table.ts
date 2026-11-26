import { id, type Row, table, text, timestamp, timestamps } from '@cslug/database'

export const users = table('users', {
  id: id(),
  name: text(),
  email: text().unique(),
  passwordHash: text(),
  emailVerifiedAt: timestamp().nullable(),
  ...timestamps(),
})

export type User = Row<typeof users>
