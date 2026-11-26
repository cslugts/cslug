import { resolve } from '@cslug/core'
import { Database, seeder, sql } from '@cslug/database'

export default seeder(async () => {
  await resolve(Database).exec(sql`insert into notes (body) values ('seeded')`)
})
