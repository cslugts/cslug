import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpTool } from '@cslug/core'
import { DEV_LOG, devTools } from '../src'
import { createApp } from './fixture/bootstrap/app'
import { BIN, cli, FIXTURE, tempDatabase } from './support'

const call = async (tools: McpTool[], name: string, args: Record<string, unknown> = {}) =>
  (tools.find((t) => t.name === name) as McpTool).call(args) as Promise<Record<string, unknown>>

describe('cslug mcp:dev over stdio', () => {
  test('initialize, tools/list, tools/call: only MCP messages on stdout', async () => {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'routes', arguments: { filter: 'health' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'routes', arguments: { filter: 3 } } },
    ]
    const proc = Bun.spawn([process.execPath, BIN, 'mcp:dev'], {
      cwd: FIXTURE,
      stdin: new TextEncoder().encode(messages.map((m) => JSON.stringify(m)).join('\n') + '\n'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const replies = out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4])
    expect(replies[0].result.serverInfo.name).toContain('(dev)')
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
      'describe',
      'routes',
      'tables',
      'query',
      'logs',
      'last_error',
      'run_test',
      'docs_search',
    ])
    expect(replies[2].result.structuredContent.routes.map((r: { name: string }) => r.name)).toEqual([
      'health.live',
      'health.ready',
    ])
    expect(replies[3].result).toMatchObject({ isError: true })
    expect(replies[3].result.content[0].text).toContain('Invalid arguments')
  })

  test('refused in production', async () => {
    const { code, out } = await cli(['mcp:dev'], { env: 'production' })
    expect(code).toBe(1)
    expect(out).toContain('does not run when app.env is production')
  })
})

describe('the dev tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'cslug-mcp-dev-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const tools = devTools(createApp({ root }))
  const log = (entries: { role?: string; stream?: string; line: string }[]) => {
    mkdirSync(join(root, '.cslug'), { recursive: true })
    writeFileSync(
      join(root, DEV_LOG),
      entries
        .map((e, i) => JSON.stringify({ t: `2026-11-27T10:00:0${i}Z`, role: 'web', stream: 'stdout', ...e }))
        .join('\n') + '\n',
    )
  }

  test('describe: section sizes, or one section; an unknown one names the others', async () => {
    const app = createApp()
    await app.start()
    const live = devTools(app)
    expect(await call(live, 'describe')).toMatchObject({ sections: { providers: 1, routes: expect.any(Number) } })
    expect(await call(live, 'describe', { section: 'providers' })).toEqual({ providers: ['HttpProvider'] })
    expect(call(live, 'describe', { section: 'jobs' })).rejects.toThrow('No "jobs" section')
    expect(call(live, 'tables')).rejects.toThrow('sections: providers, config, routes')
    await app.shutdown()
  })

  test('logs and last_error read .cslug/dev.log (JSON log lines parsed, filters)', async () => {
    expect(() => call(tools, 'logs')).toThrow('start the app with `cslug dev`')
    log([
      { line: JSON.stringify({ level: 'info', msg: 'request', path: '/' }) },
      { line: JSON.stringify({ level: 'error', msg: 'http.error', error: 'boom' }) },
      { role: 'worker', line: JSON.stringify({ level: 'info', msg: 'job.done' }) },
      { line: 'plain text line' },
    ])
    const all = (await call(tools, 'logs')).entries as Record<string, unknown>[]
    expect(all).toHaveLength(4)
    expect(all[0]).toMatchObject({ role: 'web', log: { msg: 'request' } })
    expect(all[3]).toMatchObject({ line: 'plain text line' })
    expect(((await call(tools, 'logs', { role: 'worker' })).entries as unknown[]).length).toBe(1)
    expect(((await call(tools, 'logs', { level: 'error' })).entries as unknown[]).length).toBe(1)
    expect(((await call(tools, 'logs', { lines: 2 })).entries as unknown[]).length).toBe(2)
    expect(await call(tools, 'last_error')).toMatchObject({
      role: 'web',
      log: { msg: 'http.error' },
      after: ['plain text line'],
    })

    log([
      { line: 'ok' },
      { stream: 'stderr', line: 'TypeError: x is not a function' },
      { stream: 'stderr', line: '    at handler (app/controllers/home-controller.ts:12:3)' },
    ])
    expect(await call(tools, 'last_error')).toMatchObject({
      line: 'TypeError: x is not a function',
      after: ['    at handler (app/controllers/home-controller.ts:12:3)'],
    })
    log([{ line: 'all good' }])
    expect(await call(tools, 'last_error')).toBe('No error in the log since `cslug dev` started.' as never)
  })

  test('run_test: bun test in the app (a path, a name); the outcome and the output', async () => {
    writeFileSync(
      join(root, 'math.test.ts'),
      "import { test, expect } from 'bun:test'\ntest('adds', () => expect(1 + 1).toBe(2))\ntest('breaks', () => expect(1).toBe(2))\n",
    )
    const failing = await call(tools, 'run_test', { path: 'math.test.ts' })
    expect(failing).toMatchObject({ passed: false, exitCode: 1 })
    expect(String(failing.output)).toContain('1 fail')
    expect(await call(tools, 'run_test', { path: 'math.test.ts', name: 'adds' })).toMatchObject({ passed: true })
    expect(call(tools, 'run_test', { path: '../elsewhere' })).rejects.toThrow('inside the app')
  })

  test('docs_search: sections of node_modules/@cslug/*/docs, best match first', async () => {
    const docs = join(root, 'node_modules/@cslug/queue/docs')
    mkdirSync(docs, { recursive: true })
    writeFileSync(
      join(docs, 'README.md'),
      '# @cslug/queue\n\nIntro.\n\n## Retries\n\nA job retries with backoff (`tries`, `backoff`).\n\n## Unique jobs\n\nOne job per key.\n',
    )
    const { results } = (await call(tools, 'docs_search', { query: 'job backoff' })) as {
      results: { package: string; heading: string; text: string }[]
    }
    expect(results[0]).toMatchObject({ package: '@cslug/queue', heading: 'Retries' })
    expect(results.map((r) => r.heading)).toContain('Unique jobs')
    expect(((await call(tools, 'docs_search', { query: 'nothing-like-this' })).results as unknown[]).length).toBe(0)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('query (read-only, development database)', () => {
  test('rows (bigint as text, limit), and writes refused', async () => {
    const db = await tempDatabase()
    if (!db) return
    const app = createApp({ databaseUrl: db.url })
    await app.start()
    const tools = devTools(app)
    expect(await call(tools, 'query', { sql: 'select 1 as n, 9007199254740993::bigint as big' })).toEqual({
      rowCount: 1,
      truncated: false,
      rows: [{ n: 1, big: '9007199254740993' }],
    })
    const many = await call(tools, 'query', { sql: 'select generate_series(1, 20) as i', limit: 5 })
    expect(many).toMatchObject({ rowCount: 20, truncated: true })
    expect((many.rows as unknown[]).length).toBe(5)
    expect(call(tools, 'query', { sql: 'create table oops (i int)' })).rejects.toThrow(/read-only/)
    await app.shutdown()
    await db.drop()
  })

  test('without a database, it says so', async () => {
    expect(call(devTools(createApp()), 'query', { sql: 'select 1' })).rejects.toThrow('No database')
  })
})
