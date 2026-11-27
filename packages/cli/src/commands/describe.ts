import { type Application, arg, Command, DESCRIBE, type DescribeSection, flag } from '@cslug/core'

const flat = (row: unknown): row is Record<string, unknown> =>
  typeof row === 'object' && row !== null && !Array.isArray(row)
const cell = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v !== 'object')
    ? value.join(', ')
    : typeof value === 'object' && value !== null
      ? JSON.stringify(value)
      : value

/** The sections `describe` knows: those the installed packages contribute, plus `providers` and `config` (keys). */
export function describeSections(app: Application): Map<string, () => unknown> {
  const sections = new Map<string, () => unknown>([
    ['providers', () => app.providers.map((p) => p.name)],
    [
      'config',
      () =>
        Object.fromEntries(
          Object.entries(app.configs).map(([name, value]) => [name, flat(value) ? Object.keys(value) : []]),
        ),
    ],
  ])
  for (const s of app.tagged<DescribeSection>(DESCRIBE)) sections.set(s.name, s.collect)
  return sections
}

/**
 * `cslug describe [section] [--json]`: the app as data, for people, scripts and AI coding agents. Sections come from
 * the installed packages (routes, tables, jobs, schedules) plus `providers` and `config` (keys only, never values).
 */
export class DescribeCommand extends Command {
  static signature = 'describe'
  static description = 'The app as data: routes, tables, jobs, schedules, providers, config keys (--json)'
  static args = {
    section: arg.string().optional().describe('One section; without it, a summary (or everything with --json)'),
    json: flag.boolean().describe('Machine-readable output'),
  }

  async handle({ section, json }: Command.Args<typeof DescribeCommand>) {
    const sections = describeSections(this.app)

    if (!section) {
      const all: Record<string, unknown> = {}
      for (const [name, collect] of sections) all[name] = await collect()
      if (json) return this.line(JSON.stringify(all))
      return this.table(
        Object.entries(all).map(([name, data]) => ({
          section: name,
          entries: Array.isArray(data) ? data.length : flat(data) ? Object.keys(data).length : 0,
        })),
      )
    }
    const collect = sections.get(section)
    if (!collect) {
      this.error(`No section "${section}". Sections: ${[...sections.keys()].join(', ')}`)
      return 1
    }
    const data = await collect()
    if (json) this.line(JSON.stringify(data))
    else if (Array.isArray(data) && data.every(flat))
      this.table(data.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]))))
    else this.line(JSON.stringify(data, null, 2))
  }
}
