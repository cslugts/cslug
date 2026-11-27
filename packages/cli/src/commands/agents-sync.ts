import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Application, Command, flag } from '@cslug/core'
import { describeSections } from './describe'

/** A generated section: its marker name and Markdown body. */
export type AgentsSection = { name: string; body: string }

const begin = (name: string) => `<!-- cslug:begin ${name} -->`
const end = (name: string) => `<!-- cslug:end ${name} -->`
const off = (name: string) => `<!-- cslug:off ${name} -->`

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Merge generated sections into an AGENTS.md: the text between `cslug:begin` / `cslug:end` markers is replaced,
 * everything else is kept as written. A section without markers is appended (unless `<!-- cslug:off name -->` is
 * in the file); a new file gets a short hand-editable header first.
 */
export function mergeAgents(existing: string | undefined, sections: AgentsSection[], title = 'this app'): string {
  let text =
    existing ??
    `# AGENTS.md\n\nInstructions for AI coding agents working on ${title}.\n\n## Project notes\n\n` +
      '<!-- Hand-written: domain glossary, decisions, things not to do. `cslug agents:sync` rewrites only the\n' +
      '     sections between cslug:begin and cslug:end markers; everything else in this file is kept. -->\n'
  for (const { name, body } of sections) {
    if (text.includes(off(name))) continue
    const block = `${begin(name)}\n${body.trim()}\n${end(name)}`
    const pattern = new RegExp(`${escapeRegExp(begin(name))}[\\s\\S]*?${escapeRegExp(end(name))}`)
    text = pattern.test(text) ? text.replace(pattern, () => block) : `${text.trimEnd()}\n\n${block}\n`
  }
  return text.endsWith('\n') ? text : `${text}\n`
}

type Json = Record<string, unknown>
const readJson = (path: string): Json | undefined =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Json) : undefined

/** Folders cslug apps use, in the order they are listed, with what goes in them. */
const LAYOUT: [string, string][] = [
  ['app/controllers', 'HTTP controllers (`booking-controller.ts` → `BookingController`)'],
  ['app/validators', '`v` schemas shared by requests, jobs and agents'],
  ['app/tables', 'table definitions (columns, indexes): the source of `make:migration --from-tables`'],
  ['app/repositories', 'data access (`Repository` subclasses, the `sql` tag for joins)'],
  ['app/services', 'domain logic, `@inject()` classes'],
  ['app/policies', 'authorization (`auth.authorize(Policy, ability, row)`)'],
  ['app/jobs', 'queued jobs (`Job` subclasses, discovered)'],
  ['app/listeners', 'event listeners (discovered)'],
  ['app/events', 'events (`Event<Payload>(name)`)'],
  ['app/mail', 'mailables'],
  ['app/notifications', 'notifications'],
  ['app/agents', 'AI agents (`Agent` subclasses)'],
  ['app/tools', 'AI tools (`Tool` subclasses; `@mcp()` exposes them)'],
  ['app/commands', 'app commands (`*-command.ts`, discovered by `cslug`)'],
  ['app/providers', 'service providers'],
  ['config', 'one file per package (`config/database.ts`…), values from `env`'],
  ['routes', 'route files (`web.ts`, `api.ts`)'],
  ['resources/views', 'Vue pages rendered on the server'],
  ['resources/components', 'Vue components (islands where used with `hydrate`)'],
  ['resources/prompts', 'AI prompts (Markdown with `{{ variables }}`)'],
  ['database/migrations', 'SQL migrations (`-- up` / `-- down`)'],
  ['database/seeders', 'seeders'],
  ['tests', '`bun test` files (`testApp()`, fakes)'],
]

/** Rules that hold in every cslug app, plus those of the installed packages. */
function rules(installed: Set<string>): string[] {
  const has = (p: string) => installed.has(`@cslug/${p}`)
  return [
    'Files are kebab-case and named after their export (`TripRepository` → `trip-repository.ts`); no dots except `.test.ts`.',
    'Classes are wired with standard decorators: `@inject(A, B)` lists the constructor dependencies in order.',
    'Errors are typed (`NotFoundError`, `ConflictError`, a `CslugError` code); never throw strings.',
    'Time comes from an injected `Clock` (`clock.now()`, `clock.today()`); never `new Date()` in app code.',
    'Money is integer minor units (`bigint`); ids are UUIDv7.',
    'Input is validated with `v` schemas before use.',
    ...(has('database')
      ? [
          'SQL goes through the query builder or the `sql` tag, never string concatenation; schema changes are migrations.',
        ]
      : []),
    ...(has('http') ? ['Requests are validated with `await request.validate(Schema)`.'] : []),
    ...(has('auth')
      ? ["Check access with `auth.authorize(Policy, 'ability', row)` before touching another user's data."]
      : []),
    ...(has('vue') ? ['Island props must be `Serialized<T>` (pass rows through `serialize()`).'] : []),
    ...(has('queue')
      ? ['Slow or retried work is a `Job`; jobs dispatched in a transaction run after it commits.']
      : []),
    ...(has('ai')
      ? [
          'Agents and tools are `@inject()` classes; tests answer agents with `t.ai.respond()` / `t.ai.fixture()`, never the real model.',
        ]
      : []),
    'Tests use `testApp()` and its fakes (`fakes: [...]`); a change is done when the typecheck and the tests pass.',
  ]
}

const list = (items: string[], more = 0, hint = '') =>
  items.length ? `${items.map((i) => `- ${i}`).join('\n')}${more ? `\n- … ${more} more (${hint})` : ''}` : '- none'

/** The generated sections of this app's AGENTS.md. */
export async function agentsSections(app: Application, commands: { signature: string }[]): Promise<AgentsSection[]> {
  const root = app.rootDir
  const pkg = readJson(join(root, 'package.json')) ?? {}
  const declared = { ...(pkg.dependencies as Json), ...(pkg.devDependencies as Json) }
  const cslug = Object.keys(declared)
    .filter((name) => name.startsWith('@cslug/'))
    .sort()
  const installed = new Set(cslug)
  const version = (name: string) =>
    String(readJson(join(root, 'node_modules', name, 'package.json'))?.version ?? declared[name])

  const stack = [
    'cslug on Bun, TypeScript and PostgreSQL. Each installed package ships its docs for this version:',
    '',
    list(
      cslug.map((name) => {
        const docs = `node_modules/${name}/docs`
        return existsSync(join(root, docs))
          ? `\`${name}\` ${version(name)}: \`${docs}/README.md\`, \`${docs}/api.md\``
          : `\`${name}\` ${version(name)}`
      }),
    ),
  ]

  const scripts = Object.entries((pkg.scripts as Record<string, string> | undefined) ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const groups = new Map<string, string[]>()
  for (const { signature } of commands) {
    const group = signature.includes(':') ? (signature.split(':')[0] as string) : ''
    groups.set(group, [...(groups.get(group) ?? []), signature])
  }
  const commandLines = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([group, sigs]) =>
        `${group ? `\`${group}:\`` : 'general'}: ${sigs
          .sort()
          .map((s) => `\`${s}\``)
          .join(', ')}`,
    )
  const commandsBody = [
    '## Commands',
    '',
    ...(scripts.length
      ? ['Scripts (`bun run <name>`):', '', list(scripts.map(([name, cmd]) => `\`${name}\`: \`${cmd}\``)), '']
      : []),
    '`cslug` commands (`bunx cslug <command> --help` for their arguments):',
    '',
    list(commandLines),
  ]

  const layout = LAYOUT.filter(([dir]) => existsSync(join(root, dir)))
  const layoutBody = ['## Where things go', '', list(layout.map(([dir, what]) => `\`${dir}/\`: ${what}`))]

  const sections = describeSections(app)
  const collect = async <T>(name: string): Promise<T[]> => ((await sections.get(name)?.()) as T[] | undefined) ?? []
  const routes = await collect<{ method: string; path: string; name?: string; action?: string }>('routes')
  const tables = await collect<{ name: string; columns: { name: string; references?: string }[] }>('tables')
  const jobs = await collect<{ name: string; queue?: string }>('jobs')
  const schedules = await collect<{ name: string; when: string; job?: string }>('schedules')
  const own = routes.filter((r) => !r.path.startsWith('/health/'))
  const shown = own.slice(0, 60)
  const appBody = [
    '## This app',
    '',
    'From `cslug describe` (`--json` for every detail; `cslug mcp:dev` serves it live).',
    '',
    `Routes (${own.length}, besides /health/*):`,
    '',
    list(
      shown.map(
        (r) =>
          `\`${r.method} ${r.path}\`${r.name ? ` ${r.name}` : ''}${r.action && r.action !== 'closure' ? ` → ${r.action}` : ''}`,
      ),
      own.length - shown.length,
      'cslug describe routes',
    ),
    '',
    `Tables (${tables.length}):`,
    '',
    list(
      tables.map(
        (t) =>
          `\`${t.name}\`: ${t.columns.map((c) => (c.references ? `${c.name} → ${c.references}` : c.name)).join(', ')}`,
      ),
    ),
    ...(sections.has('jobs')
      ? [
          '',
          `Jobs (${jobs.length}):`,
          '',
          list(jobs.map((j) => `\`${j.name}\`${j.queue ? ` (queue ${j.queue})` : ''}`)),
        ]
      : []),
    ...(sections.has('schedules')
      ? [
          '',
          `Schedules (${schedules.length}):`,
          '',
          list(schedules.map((s) => `\`${s.name}\`: ${s.when}${s.job ? ` → ${s.job}` : ''}`)),
        ]
      : []),
  ]

  const check = ['typecheck', 'test'].filter((s) => scripts.some(([name]) => name === s)).map((s) => `bun run ${s}`)
  const toolsBody = [
    '## Tools for agents',
    '',
    `- Before finishing: \`${check.length ? check.join(' && ') : 'bun test'}\`.`,
    '- `cslug mcp:dev` is a development MCP server for this app: describe, routes, tables, read-only `query`, `logs` and',
    '  `last_error` (from `cslug dev`), `run_test`, `docs_search`:',
    '',
    '  ```json',
    '  { "mcpServers": { "cslug": { "command": "bunx", "args": ["cslug", "mcp:dev"] } } }',
    '  ```',
    '- Generators give each kind of class its canonical shape: prefer `cslug make:<kind> Name` to writing one from scratch.',
  ]

  return [
    { name: 'stack', body: ['## Stack', '', ...stack].join('\n') },
    { name: 'rules', body: ['## Rules', '', list(rules(installed))].join('\n') },
    { name: 'layout', body: layoutBody.join('\n') },
    { name: 'commands', body: commandsBody.join('\n') },
    { name: 'app', body: appBody.join('\n') },
    { name: 'tools', body: toolsBody.join('\n') },
  ]
}

/**
 * `cslug agents:sync`: writes the generated sections of AGENTS.md (stack, rules, layout, commands, the app's routes
 * and tables, tools), keeping every hand-written line. `--check` only reports whether the file is up to date (CI).
 */
export class AgentsSyncCommand extends Command {
  static signature = 'agents:sync'
  static description = 'Update the generated sections of AGENTS.md (hand-written text is kept); --check for CI'
  static args = {
    check: flag.boolean().describe('Exit 1 if AGENTS.md is not up to date; write nothing'),
    file: flag.string().optional().describe('Default: AGENTS.md'),
  }

  async handle({ check, file = 'AGENTS.md' }: Command.Args<typeof AgentsSyncCommand>) {
    const path = resolve(this.app.rootDir, file)
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    const { CliKernel } = await import('../kernel')
    const commands = [...(await new CliKernel(this.app).commands()).values()]
    const name = String(readJson(join(this.app.rootDir, 'package.json'))?.name ?? 'this app')
    const next = mergeAgents(existing, await agentsSections(this.app, commands), `\`${name}\``)
    if (next === existing) {
      this.success(`${file} is up to date`)
      return 0
    }
    if (check) {
      this.error(`${file} is out of date: run \`cslug agents:sync\``)
      return 1
    }
    writeFileSync(path, next)
    this.success(`${existing === undefined ? 'Created' : 'Updated'} ${file}`)
    return 0
  }
}
