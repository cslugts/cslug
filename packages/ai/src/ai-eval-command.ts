import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { arg, Command, flag } from '@cslug/core'
import { Agent } from './agent'
import { Ai, AiOutputError } from './ai'
import { FIXTURES_DIR, readFixture } from './fake'

/** Where two JSON values differ, as `path: before → after` lines. */
export function jsonDiff(before: unknown, after: unknown, path = ''): string[] {
  const show = (x: unknown) => (x === undefined ? '(none)' : JSON.stringify(x))
  if (Object.is(before, after)) return []
  const objects = before && after && typeof before === 'object' && typeof after === 'object'
  if (!objects || Array.isArray(before) !== Array.isArray(after))
    return [`${path || '(answer)'}: ${show(before)} → ${show(after)}`]
  const a = before as Record<string, unknown>
  const b = after as Record<string, unknown>
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  return keys.flatMap((k) => jsonDiff(a[k], b[k], Array.isArray(before) ? `${path}[${k}]` : path ? `${path}.${k}` : k))
}

/** The agent classes exported by the modules under `app/agents/`, by class name. */
async function agentClasses(rootDir: string): Promise<Map<string, new () => Agent>> {
  const dir = join(rootDir, 'app/agents')
  const found = new Map<string, new () => Agent>()
  if (!existsSync(dir)) return found
  for (const file of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /(?<!\.test)\.ts$/.test(f)))
    for (const value of Object.values(await import(join(dir, file))))
      if (typeof value === 'function' && value.prototype instanceof Agent)
        found.set(value.name, value as new () => Agent)
  return found
}

/**
 * `cslug ai:eval [folder]`: every fixture under `tests/fixtures/ai/<folder>` through the real model. A schema failure or
 * an error fails the command; a different answer is reported as a diff (failing only with `--strict`).
 */
export class AiEvalCommand extends Command {
  static signature = 'ai:eval'
  static description = 'Run recorded AI fixtures through the real model: schema failures and diffs (calls the API)'
  static args = {
    folder: arg.string().optional().describe(`A folder under ${FIXTURES_DIR}, e.g. proposals`),
    strict: flag.boolean().describe('Fail when an answer differs from its fixture'),
    json: flag.boolean(),
  }

  async handle({ folder, strict, json }: Command.Args<typeof AiEvalCommand>) {
    const dir = join(this.app.rootDir, FIXTURES_DIR, folder ?? '')
    const files = existsSync(dir)
      ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.json')).sort()
      : []
    if (!files.length) {
      this.warn(`No fixtures in ${join(FIXTURES_DIR, folder ?? '')} (record them with cslug ai:record)`)
      return 1
    }
    const agents = await agentClasses(this.app.rootDir)
    const ai = this.app.resolve(Ai)
    const rows: { fixture: string; result: string; details: string; costUsd?: number }[] = []
    for (const file of files) {
      const fixture = readFixture(join(dir, file))
      const name = join(folder ?? '', file.replace(/\.json$/, ''))
      const cls = agents.get(fixture.agent)
      if (!cls) {
        rows.push({ fixture: name, result: 'error', details: `No agent ${fixture.agent} in app/agents` })
        continue
      }
      try {
        const result = await ai.result(this.app.resolve(cls), { input: fixture.input, context: fixture.context })
        const diff = jsonDiff(fixture.output, result.raw)
        rows.push({
          fixture: name,
          result: diff.length ? 'diff' : 'same',
          details: diff.join('\n'),
          costUsd: result.costUsd,
        })
      } catch (error) {
        const schema = error instanceof AiOutputError
        rows.push({
          fixture: name,
          result: schema ? 'schema' : 'error',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const failed = rows.filter((r) => r.result === 'schema' || r.result === 'error' || (strict && r.result === 'diff'))
    const cost = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    if (json) this.line(JSON.stringify(rows))
    else {
      this.table(rows.map(({ costUsd: _, ...row }) => row))
      const count = (result: string) => rows.filter((r) => r.result === result).length
      const summary = `${count('same')} same, ${count('diff')} diff, ${count('schema')} schema failures, ${count('error')} errors (~$${cost.toFixed(4)})`
      if (failed.length) this.error(summary)
      else this.success(summary)
    }
    return failed.length ? 1 : 0
  }
}
