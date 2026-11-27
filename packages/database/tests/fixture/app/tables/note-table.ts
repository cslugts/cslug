import { id, table, text, timestamps, uuid } from '../../../../src'

export const authors = table('authors', { id: id(), name: text().unique() })

export const notes = table(
  'notes',
  {
    id: id(),
    authorId: uuid().references(() => authors, { onDelete: 'cascade' }),
    status: text().oneOf(['draft', 'published']).default('draft'),
    body: text().nullable(),
    ...timestamps(),
  },
  { indexes: (t) => [t.index('status')] },
)
