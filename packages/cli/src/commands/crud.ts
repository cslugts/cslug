import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, flag, names } from '@cslug/core'

const STUBS = join(import.meta.dir, '../../stubs/crud')

/** `claim` → `claims`, `category` → `categories` (the same rule the router uses to name resource parameters). */
const plural = (word: string) => (/[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`)

const stamp = (now: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

/**
 * `cslug make:crud Claim`: a resource owned by the signed-in user, from table to test: the table and its migration,
 * a repository, a validator, a policy, a resource controller, four views and a feature test. Needs the `--web`
 * preset's packages (@cslug/vue, @cslug/auth) and its `users` table.
 */
export class MakeCrudCommand extends Command {
  static signature = 'make:crud'
  static description = 'Create a resource: table, migration, repository, validator, policy, controller, views, test'
  static boot = false
  static args = { name: arg.string().describe('Singular, e.g. Claim or TripRequest'), force: flag.boolean() }

  handle({ name, force }: Command.Args<typeof MakeCrudCommand>) {
    const root = this.app.rootDir
    const missing = ['@cslug/vue', '@cslug/auth', '@cslug/database'].filter(
      (p) => !existsSync(join(root, 'node_modules', p)),
    )
    if (missing.length) {
      this.error(`make:crud needs ${missing.join(', ')} (the --web preset): views, policies and the users table`)
      return 1
    }
    const n = names(name.replace(/\//g, ''))
    const pluralKebab = plural(n.kebab)
    const vars = {
      ...n,
      plural: pluralKebab,
      tableName: pluralKebab.replace(/-/g, '_'),
      tableVar: plural(n.camel),
      title: plural(n.kebab)
        .replace(/-/g, ' ')
        .replace(/^./, (c) => c.toUpperCase()),
    }
    const files: [stub: string, target: string][] = [
      ['table.stub', `app/tables/${n.kebab}-table.ts`],
      ['migration.stub', `database/migrations/${stamp(this.clock.now())}_create_${vars.tableName}.sql`],
      ['repository.stub', `app/repositories/${n.kebab}-repository.ts`],
      ['validator.stub', `app/validators/store-${n.kebab}-validator.ts`],
      ['policy.stub', `app/policies/${n.kebab}-policy.ts`],
      ['controller.stub', `app/controllers/${n.kebab}-controller.ts`],
      ['view.index.stub', `resources/views/${pluralKebab}/index.vue`],
      ['view.show.stub', `resources/views/${pluralKebab}/show.vue`],
      ['view.form.stub', `resources/views/${pluralKebab}/create.vue`],
      ['view.form.stub', `resources/views/${pluralKebab}/edit.vue`],
      ['test.stub', `tests/feature/${pluralKebab}.test.ts`],
    ]
    let ok = true
    for (const [stub, target] of files) ok = this.generate(STUBS, stub, target, vars, force) && ok
    if (!ok) return 1
    this.line()
    this.line('  Next:')
    this.line(`  1. routes/web.ts, in a group with auth():  r.resource('${pluralKebab}', ${n.base}Controller)`)
    this.line('  2. cslug migrate')
    this.line(`  3. bun test tests/feature/${pluralKebab}.test.ts`)
    return 0
  }
}
