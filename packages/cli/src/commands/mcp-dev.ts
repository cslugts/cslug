import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'
import { type Application, Command, Logger, type McpTool, serveMcpStdio, v } from '@cslug/core'
import { DEV_LOG } from '../supervisor'
import { describeSections } from './describe'

/** An MCP tool whose arguments are checked with a `v` schema. */
function tool<
  S extends {
    _output: unknown
    toJSONSchema(): object
    safeParse(x: unknown): { success: true; data: unknown } | { success: false; error: { issues: unknown } }
  },
>(name: string, description: string, input: S, handle: (args: S['_output']) => unknown): McpTool {
  return {
    name,
    description,
    inputSchema: input.toJSONSchema() as Record<string, unknown>,
    call: (args) => {
      const parsed = input.safeParse(args)
      if (!parsed.success) throw new Error(`Invalid arguments: ${JSON.stringify(parsed.error.issues)}`)
      return handle(parsed.data as never)
    },
  }
}

/** Query rows as JSON can carry them (bigint → string). */
const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)))

type LogEntry = { t: string; role: string; stream: 'stdout' | 'stderr'; line: string }

/** The last `.cslug/dev.log` entries (the file can be large: only its tail is read). */
function readLog(rootDir: string, maxBytes = 2_000_000): LogEntry[] {
  const path = join(rootDir, DEV_LOG)
  if (!existsSync(path))
    throw new Error(`No ${DEV_LOG}: start the app with \`cslug dev\` (it writes what the app prints there)`)
  const size = statSync(path).size
  const text = readFileSync(path, 'utf8')
  const tail = size > maxBytes ? text.slice(-maxBytes).replace(/^[^\n]*\n/, '') : text
  return tail
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LogEntry]
      } catch {
        return []
      }
    })
}

/** A log line's own JSON (the app's logger writes JSON lines), or undefined. */
const json = (line: string): Record<string, unknown> | undefined => {
  if (!line.startsWith('{')) return undefined
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const isError = (e: LogEntry) => {
  const level = json(e.line)?.level
  return level === 'error' || level === 'fatal' || (e.stream === 'stderr' && /(error|exception)\b/i.test(e.line))
}

/** Markdown files split into sections at their headings. */
function docSections(rootDir: string): { package: string; file: string; heading: string; text: string }[] {
  const scope = join(rootDir, 'node_modules/@cslug')
  if (!existsSync(scope)) return []
  const sections: { package: string; file: string; heading: string; text: string }[] = []
  for (const pkg of readdirSync(scope)) {
    const docs = join(scope, pkg, 'docs')
    if (!existsSync(docs)) continue
    for (const file of (readdirSync(docs, { recursive: true }) as string[]).filter((f) => f.endsWith('.md'))) {
      let heading = file
      let lines: string[] = []
      const flush = () => {
        if (lines.join('').trim()) sections.push({ package: `@cslug/${pkg}`, file, heading, text: lines.join('\n') })
        lines = []
      }
      for (const line of readFileSync(join(docs, file), 'utf8').split('\n')) {
        const h = /^#{1,4}\s+(.*)/.exec(line)
        if (h) {
          flush()
          heading = h[1] as string
        }
        lines.push(line)
      }
      flush()
    }
  }
  return sections
}

/** The development tools `cslug mcp:dev` serves, for coding agents working on this app. */
export function devTools(app: Application): McpTool[] {
  const sections = () => describeSections(app)
  const section = async (name: string) => {
    const collect = sections().get(name)
    if (!collect)
      throw new Error(
        `No "${name}" section (its package is not installed); sections: ${[...sections().keys()].join(', ')}`,
      )
    return collect()
  }
  return [
    tool(
      'describe',
      'The app as data (what `cslug describe` shows): routes, tables, jobs, schedules, providers, config keys. Without a section: the section names and sizes.',
      v.object({ section: v.string().optional() }),
      async ({ section: name }) => {
        if (name) return { [name]: await section(name) }
        const summary: Record<string, number> = {}
        for (const [key, collect] of sections()) {
          const data = await collect()
          summary[key] = Array.isArray(data)
            ? data.length
            : data && typeof data === 'object'
              ? Object.keys(data).length
              : 0
        }
        return { sections: summary }
      },
    ),
    tool(
      'routes',
      'HTTP routes: method, path, name, action, middleware. `filter` keeps those whose path, name or action contains it.',
      v.object({ filter: v.string().optional() }),
      async ({ filter }) => {
        const routes = (await section('routes')) as Record<string, unknown>[]
        const kept = filter
          ? routes.filter((r) => [r.path, r.name, r.action].some((x) => String(x ?? '').includes(filter)))
          : routes
        return { routes: kept }
      },
    ),
    tool(
      'tables',
      'Database tables declared in app code: columns (type, nullable, unique, default, references) and indexes. `name` for one table.',
      v.object({ name: v.string().optional() }),
      async ({ name }) => {
        const tables = (await section('tables')) as { name?: string }[]
        return { tables: name ? tables.filter((t) => t.name === name) : tables }
      },
    ),
    tool(
      'query',
      'Run one read-only SQL query on the development database (a read-only transaction, rolled back; 5 s timeout). Inline values in the SQL. Returns at most `limit` rows (default 50, max 500).',
      v.object({ sql: v.string().min(1), limit: v.int().min(1).max(500).optional() }),
      async ({ sql: text, limit = 50 }) => {
        const db = await import('@cslug/database').catch(() => undefined)
        if (!db || !app.has(db.Database))
          throw new Error('No database: @cslug/database is not installed or not configured')
        const { sql } = db
        const rollback = Symbol('rollback')
        let rows: unknown[] = []
        await app
          .resolve(db.Database)
          .transaction(async (tx) => {
            await tx.exec(sql`set transaction read only`)
            await tx.exec(sql`set local statement_timeout = '5s'`)
            rows = await tx.many(sql`${sql.raw(text)}`)
            throw rollback
          })
          .catch((e) => {
            if (e !== rollback) throw e
          })
        return { rowCount: rows.length, truncated: rows.length > limit, rows: plain(rows.slice(0, limit)) }
      },
    ),
    tool(
      'logs',
      `What the app printed under \`cslug dev\` (${DEV_LOG}), newest last: its JSON log lines parsed. Filter by role (web, worker…), level or text.`,
      v.object({
        lines: v.int().min(1).max(1000).optional(),
        role: v.string().optional(),
        level: v.enum(['debug', 'info', 'warn', 'error', 'fatal']).optional(),
        contains: v.string().optional(),
      }),
      ({ lines = 100, role, level, contains }) => {
        const entries = readLog(app.rootDir).filter(
          (e) =>
            (!role || e.role === role) &&
            (!level || json(e.line)?.level === level) &&
            (!contains || e.line.includes(contains)),
        )
        return {
          entries: entries.slice(-lines).map((e) => ({
            t: e.t,
            role: e.role,
            stream: e.stream,
            ...(json(e.line) ? { log: json(e.line) } : { line: e.line }),
          })),
        }
      },
    ),
    tool(
      'last_error',
      `The most recent error the app logged or printed under \`cslug dev\` (${DEV_LOG}), with the lines that followed it (a stack trace).`,
      v.object({}),
      () => {
        const entries = readLog(app.rootDir)
        let at = -1
        for (let i = entries.length - 1; i >= 0; i--)
          if (isError(entries[i] as LogEntry)) {
            at = i
            break
          }
        if (at < 0) return 'No error in the log since `cslug dev` started.'
        const entry = entries[at] as LogEntry
        const after = entries
          .slice(at + 1)
          .filter((e) => e.role === entry.role)
          .slice(0, 30)
          .map((e) => e.line)
        return {
          t: entry.t,
          role: entry.role,
          ...(json(entry.line) ? { log: json(entry.line) } : { line: entry.line }),
          after,
        }
      },
    ),
    tool(
      'run_test',
      'Run `bun test` in the app (optionally one file or folder, and a test name pattern). Returns whether it passed and the end of the output.',
      v.object({ path: v.string().optional(), name: v.string().optional() }),
      async ({ path, name }) => {
        if (path) {
          const full = resolvePath(app.rootDir, path)
          if (relative(app.rootDir, full).startsWith('..')) throw new Error('`path` must be inside the app')
        }
        const proc = Bun.spawn(['bun', 'test', ...(path ? [path] : []), ...(name ? ['-t', name] : [])], {
          cwd: app.rootDir,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        })
        const timer = setTimeout(() => proc.kill(), 180_000)
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        clearTimeout(timer)
        const output = `${out}${err}`
        return {
          passed: code === 0,
          exitCode: code,
          output: output.length > 12_000 ? `…${output.slice(-12_000)}` : output,
        }
      },
    ),
    tool(
      'docs_search',
      'Search the docs of the installed @cslug packages (node_modules/@cslug/*/docs): the best matching sections, for the installed version.',
      v.object({ query: v.string().min(2), limit: v.int().min(1).max(20).optional() }),
      ({ query, limit = 5 }) => {
        const terms = query
          .toLowerCase()
          .split(/\W+/)
          .filter((t) => t.length > 1)
        const count = (text: string, term: string) => text.split(term).length - 1
        return {
          results: docSections(app.rootDir)
            .map((s) => {
              const heading = s.heading.toLowerCase()
              const body = s.text.toLowerCase()
              const score = terms.reduce((sum, t) => sum + 3 * count(heading, t) + count(body, t), 0)
              const all = terms.every((t) => body.includes(t))
              return { ...s, score: score * (all ? 2 : 1) }
            })
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ text, score: _, ...s }) => ({
              ...s,
              text: text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text,
            })),
        }
      },
    ),
  ]
}

/**
 * `cslug mcp:dev`: a development MCP server over stdio for coding agents (Claude Code and others):
 * `{"command": "bunx", "args": ["cslug", "mcp:dev"]}`. Refused in production.
 */
export class McpDevCommand extends Command {
  static signature = 'mcp:dev'
  static description =
    'Development MCP server (stdio) for coding agents: describe, routes, tables, query, logs, tests, docs'

  async handle() {
    if (this.app.config('app.env') === 'production') {
      this.error('mcp:dev is a development tool; it does not run when app.env is production')
      return 1
    }
    this.app.swap(Logger, new Logger({ write: (line) => process.stderr.write(`${line}\n`) }))
    const tools = devTools(this.app)
    await serveMcpStdio(() => tools, { name: `${String(this.app.config('app.name') ?? 'cslug')} (dev)`, version: '1' })
    return 0
  }
}
