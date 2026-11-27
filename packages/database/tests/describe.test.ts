import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeTables } from '../src/provider'

test('describeTables: the tables app/tables exports, for cslug describe tables', async () => {
  const tables = await describeTables(join(import.meta.dir, 'fixture'))
  expect(tables.map((t) => t.name)).toEqual(['authors', 'notes'])
  const notes = tables[1]
  expect(notes?.primaryKey).toBe('id')
  expect(notes?.columns.find((c) => c.key === 'authorId')).toEqual({
    name: 'author_id',
    key: 'authorId',
    type: 'text',
    nullable: false,
    references: 'authors.id',
  })
  expect(notes?.columns.find((c) => c.key === 'status')).toMatchObject({ oneOf: ['draft', 'published'] })
  expect(notes?.columns.find((c) => c.key === 'body')?.nullable).toBe(true)
  expect(notes?.indexes).toEqual([{ columns: ['status'], unique: false, name: 'notes_status_idx' }])
  expect(await describeTables('/nonexistent')).toEqual([])
})
