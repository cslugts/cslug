/**
 * End to end, in real processes: migrate, build, `cslug start` (web + worker + scheduler), register, add a todo due
 * today, run the reminder entry, and receive the email: in Mailpit when MAILPIT_URL is set (CI), else in the
 * worker's log (MAIL_TRANSPORT=log).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { SQL } from 'bun'

const ROOT = join(import.meta.dir, '../..')
const BIN = join(ROOT, 'node_modules/.bin/cslug')
const MAILPIT_URL = process.env.MAILPIT_URL
const base = process.env.DATABASE_URL as string
const name = `starter_kit_e2e_${process.pid}`
const dbUrl = Object.assign(new URL(base), { pathname: `/${name}` }).toString()
const port = 20_000 + Math.floor(Math.random() * 20_000)
const url = `http://127.0.0.1:${port}`
const env = {
  ...process.env,
  APP_ENV: 'development',
  APP_URL: url,
  PORT: String(port),
  DATABASE_URL: dbUrl,
  MAIL_TRANSPORT: MAILPIT_URL ? 'smtp' : 'log',
  NO_COLOR: '1',
}
let admin: SQL
let server: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
let output = ''

const run = async (...args: string[]) => {
  const p = Bun.spawn([BIN, ...args], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  if (code !== 0) throw new Error(`cslug ${args.join(' ')} exited ${code}\n${out}\n${err}`)
  return out
}

const until = async (check: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve().then(check).catch(() => false)) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out waiting for ${what}\n--- cslug start output ---\n${output.slice(-4000)}`)
}

/** A tiny browser: keeps the session cookie, reads the CSRF token from pages. */
const cookies = new Map<string, string>()
const browse = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '))
  const res = await fetch(`${url}${path}`, { ...init, headers, redirect: 'manual' })
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';')
    const [k, v] = (pair as string).split('=')
    cookies.set(k as string, v as string)
  }
  return res
}
const csrfFrom = (html: string) => /name="_token" value="([^"]+)"/.exec(html)?.[1] ?? /name="csrf-token" content="([^"]+)"/.exec(html)?.[1]

beforeAll(async () => {
  admin = new SQL(Object.assign(new URL(base), { pathname: '/postgres' }).toString(), { max: 1 })
  await admin.unsafe(`drop database if exists "${name}" with (force)`)
  await admin.unsafe(`create database "${name}"`)
  await run('migrate', '--force')
  await run('build')
  server = Bun.spawn([BIN, 'start'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  for (const stream of [server.stdout, server.stderr]) {
    ;(async () => {
      const reader = stream.getReader()
      for (let r = await reader.read(); !r.done; r = await reader.read()) output += new TextDecoder().decode(r.value)
    })()
  }
  await until(async () => (await fetch(`${url}/health/ready`)).ok, 30_000, 'the web process to be ready')
}, 120_000)

afterAll(async () => {
  server?.kill('SIGTERM')
  await server?.exited
  await admin?.unsafe(`drop database if exists "${name}" with (force)`)
  await admin?.close()
})

test('register → add a todo due today → the reminder email is delivered', async () => {
  const email = `ada-${Date.now()}@example.test`

  // register through the HTML form (session + CSRF)
  const form = await browse('/register')
  expect(form.status).toBe(200)
  const token = csrfFrom(await form.text()) as string
  expect(token).toBeTruthy()
  const registered = await browse('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${url}/register` },
    body: new URLSearchParams({ _token: token, name: 'Ada', email, password: 'correct horse battery', passwordConfirmation: 'correct horse battery' }),
  })
  expect(registered.status).toBe(303) // See Other after a POST
  expect(registered.headers.get('location')).toEndWith('/todos')

  // the todo page renders, with the island and its CSRF token
  const page = await browse('/todos')
  expect(page.status).toBe(200)
  const html = await page.text()
  expect(html).toContain('data-island="components/new-todo-form"')

  // add a todo due today, as the island does (JSON + X-CSRF-Token)
  const today = new Date().toISOString().slice(0, 10)
  const created = await browse('/todos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrfFrom(html) as string },
    body: JSON.stringify({ title: 'Pay the deposit', dueOn: today, priority: 'high' }),
  })
  expect(created.status).toBe(200)

  // what the scheduler does at 07:00: dispatch the job; the worker runs it and queues the mail; the worker sends it
  await run('schedule:test', 'send-due-reminders')

  if (MAILPIT_URL) {
    let found: { ID: string; Subject: string } | undefined
    await until(
      async () => {
        const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
        found = ((await res.json()) as { messages: { ID: string; Subject: string }[] }).messages[0]
        return !!found
      },
      30_000,
      'the reminder email in Mailpit',
    )
    expect(found?.Subject).toBe('A todo is due')
    const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${found?.ID}`)).json()) as { Text: string }
    expect(message.Text).toContain('Pay the deposit')
  } else {
    await until(() => output.includes('mail.sent') && output.includes(email), 30_000, 'mail.sent in the worker log')
    expect(output).toContain('A todo is due')
  }
}, 120_000)
