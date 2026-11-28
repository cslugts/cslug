import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE, vueApp } from './support'

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium')

/** A copy of the fixture the test may edit, with @cslug/vue linked like an app installs it. */
function fixtureCopy(): string {
  const dir = mkdtempSync(join(import.meta.dir, '.hmr-'))
  cpSync(join(FIXTURE, 'resources'), join(dir, 'resources'), { recursive: true })
  cpSync(join(FIXTURE, 'package.json'), join(dir, 'package.json'))
  mkdirSync(join(dir, 'node_modules/@cslug'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@cslug/vue'), 'dir')
  return dir
}

let serverLog = ''

/** The dev server (`hmr-server.ts`) in a child process; resolves once it listens. */
async function devServer(root: string, hmr: boolean) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'hmr-server.ts'), root], {
    env: { ...process.env, CSLUG_DEV: '1', CSLUG_HMR: hmr ? '1' : '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // the server's log, shown when a step times out
  serverLog = ''
  ;(async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) serverLog += new TextDecoder().decode(chunk)
  })()
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  let out = ''
  while (!/PORT (\d+)/.test(out)) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`dev server exited: ${serverLog}`)
    out += new TextDecoder().decode(value)
  }
  return { proc, base: `http://127.0.0.1:${/PORT (\d+)/.exec(out)?.[1]}` }
}

/** Headless Chrome driven over the DevTools protocol: navigate, then evaluate expressions in the page. */
async function browser() {
  const profile = mkdtempSync(join(tmpdir(), 'cslug-chrome-'))
  const proc = Bun.spawn(
    [
      chrome as string,
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  )
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await Bun.sleep(100)
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    type: string
    webSocketDebuggerUrl: string
  }[]
  const ws = new WebSocket(targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl as string)
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  let next = 0
  const waiting = new Map<number, (v: { result?: { result?: { value?: unknown } } }) => void>()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    waiting.get(msg.id)?.(msg)
    waiting.delete(msg.id)
  })
  const send = (method: string, params: object = {}) =>
    new Promise<{ result?: { result?: { value?: unknown } } }>((resolve) => {
      const id = ++next
      waiting.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression: string) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value
  /** Wait until `expression` is truthy in the page. */
  const until = async (expression: string, ms = 15_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(expression).catch(() => false)) return
      await Bun.sleep(100)
    }
    const where = await evaluate(`location.href + ' ' + document.body?.innerHTML.slice(0, 600)`).catch(String)
    throw new Error(`timed out waiting for: ${expression}\npage: ${where}\nserver log:\n${serverLog}`)
  }
  return {
    goto: (url: string) => send('Page.navigate', { url }),
    evaluate,
    until,
    close() {
      ws.close()
      proc.kill()
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

const edit = (file: string, from: string | RegExp, to: string) => {
  const source = readFileSync(file, 'utf8')
  const next = source.replace(from, to)
  if (next === source) throw new Error(`edit did not apply to ${file}`)
  writeFileSync(file, next)
}

// the counter island's state: count is 2 once mounted (onMounted: 1 → 2); the test sets it to 41
const COUNT = `document.querySelector('.counter')?.dataset.count`
const SET_COUNT = `document.querySelector('cslug-island[data-island="components/counter"]').__vue_app__._instance.setupState.count = 41`

describe.skipIf(!chrome)('HMR under cslug dev (Chrome headless)', () => {
  let root = ''
  let server: Awaited<ReturnType<typeof devServer>> | undefined
  let page: Awaited<ReturnType<typeof browser>> | undefined
  beforeAll(async () => {
    root = fixtureCopy()
    server = await devServer(root, true)
    page = await browser()
  })
  afterAll(() => {
    page?.close()
    server?.proc.kill()
    rmSync(root, { recursive: true, force: true })
  })

  test('a template change re-renders the island in place and keeps its state', async () => {
    const p = page as NonNullable<typeof page>
    await p.goto(`${server?.base}/islands`)
    await p.until(`${COUNT} === '2' && document.documentElement.dataset.cslugLive === 'open'`)
    await p.evaluate(`window.__sameDocument = true; ${SET_COUNT}`)
    await p.until(`${COUNT} === '41'`)
    edit(join(root, 'resources/components/counter.vue'), '<output', '<b class="hot">hot</b><output')
    await p.until(`!!document.querySelector('.counter .hot')`)
    expect(await p.evaluate('window.__sameDocument')).toBe(true)
    expect(await p.evaluate(COUNT)).toBe('41')
  }, 60_000)

  test('a script change remounts the island without reloading the page', async () => {
    const p = page as NonNullable<typeof page>
    edit(join(root, 'resources/components/counter.vue'), 'count.value++', 'count.value += 10')
    await p.until(`${COUNT} === '11'`)
    expect(await p.evaluate('window.__sameDocument')).toBe(true)
  }, 60_000)

  test('a component style change replaces that component’s <style> only', async () => {
    const p = page as NonNullable<typeof page>
    await p.goto(`${server?.base}/plain`)
    await p.until(`!!document.querySelector('.plain') && document.documentElement.dataset.cslugLive === 'open'`)
    await p.evaluate('window.__sameDocument = true')
    edit(join(root, 'resources/views/plain.vue'), 'margin: 0;', 'margin: 0; color: rgb(1, 2, 3);')
    await p.until(`getComputedStyle(document.querySelector('.plain')).color === 'rgb(1, 2, 3)'`)
    expect(await p.evaluate('window.__sameDocument')).toBe(true)
  }, 60_000)

  test('a server-only template change reloads the page, which renders the new template', async () => {
    const p = page as NonNullable<typeof page>
    edit(join(root, 'resources/views/plain.vue'), 'No layout, no islands.', 'Edited on the server.')
    await p.until(`document.querySelector('.plain')?.textContent === 'Edited on the server.'`)
    expect(await p.evaluate('window.__sameDocument')).toBeUndefined()
  }, 60_000)
})

describe.skipIf(!chrome)('cslug dev --no-hmr (Chrome headless)', () => {
  test('a template change reloads the page instead', async () => {
    const root = fixtureCopy()
    const server = await devServer(root, false)
    const page = await browser()
    try {
      await page.goto(`${server.base}/islands`)
      await page.until(`${COUNT} === '2' && document.documentElement.dataset.cslugLive === 'open'`)
      await page.evaluate('window.__sameDocument = true')
      edit(join(root, 'resources/components/counter.vue'), '<output', '<b class="hot">hot</b><output')
      await page.until(`!!document.querySelector('.counter .hot')`)
      expect(await page.evaluate('window.__sameDocument')).toBeUndefined()
    } finally {
      page.close()
      server.proc.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

test('outside cslug dev there is no live endpoint and no dev client', async () => {
  const { app, call } = await vueApp((r) => r.get('/p', () => new Response('ok')))
  expect((await call('/__cslug/live')).status).toBe(404)
  await app.shutdown()
})
