import { describe, expect, test } from 'bun:test'
import { evaluate } from '../src'
import { BIN, cli, FIXTURE } from './support'

describe('cslug describe (guide 20, docs/ai-readiness.md)', () => {
  test('a summary; --json gives every section', async () => {
    const { code, out } = await cli(['describe'])
    expect(code).toBe(0)
    expect(out).toMatch(/section\s+entries/)
    expect(out).toMatch(/routes\s+\d+/)
    const all = JSON.parse((await cli(['describe', '--json'])).out)
    expect(Object.keys(all)).toEqual(['providers', 'config', 'routes'])
    expect(all.providers).toContain('HttpProvider')
  })

  test('one section, as JSON; config shows keys, never values', async () => {
    const routes = JSON.parse((await cli(['describe', 'routes', '--json'])).out)
    expect(routes).toContainEqual({
      method: 'GET',
      path: '/health/live',
      name: 'health.live',
      action: 'closure',
      middleware: [],
    })
    const config = JSON.parse((await cli(['describe', 'config', '--json'])).out)
    expect(config.app).toContain('key')
    expect(JSON.stringify(config)).not.toContain('k'.repeat(16))
  })

  test('an unknown section lists the known ones', async () => {
    const { code, out } = await cli(['describe', 'nope'])
    expect(code).toBe(1)
    expect(out).toContain('No section "nope". Sections: providers, config, routes')
  })
})

describe('cslug repl', () => {
  test('evaluate: TypeScript, await, declarations kept, incomplete input, errors', async () => {
    const scope: Record<string, unknown> = { base: 40 }
    expect(await evaluate('base + 2', scope)).toEqual({ value: 42 })
    expect(await evaluate('const n: number = await Promise.resolve(1)', scope)).toEqual({ value: undefined }) // like node
    expect(await evaluate('n + base', scope)).toEqual({ value: 41 })
    expect(await evaluate('function twice(x: number) {', scope)).toEqual({ incomplete: true })
    await evaluate('function twice(x: number) {\n  return x * 2\n}', scope)
    expect(await evaluate('twice(n)', scope)).toEqual({ value: 2 })
    expect(((await evaluate('missing()', scope)).error as Error).message).toContain('missing')
  })

  test('the command: app in scope, multi-line input, .help, .exit', async () => {
    const proc = Bun.spawn([process.execPath, BIN, 'repl'], {
      cwd: FIXTURE,
      stdin: new TextEncoder().encode(
        "typeof resolve\nconfig('app.url')\nclass Box {\n  n = 3\n}\nnew Box().n\n.help\n.exit\n",
      ),
      stdout: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out).toContain('cslug> "function"')
    expect(out).toContain('...    ...    ')
    expect(out).toContain('cslug> "http://localhost"')
    expect(out).toContain('cslug> 3')
    expect(out).toContain('In scope: Box, app, config, resolve')
  })
})
