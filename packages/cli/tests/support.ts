import { ConsoleIO } from '@cslug/core'
import { SQL } from 'bun'
import { BufferedIO, CliKernel } from '../src'
import { createApp } from './fixture/bootstrap/app'

/** Run `cslug …` in-process against the fixture app; returns the exit code and the output. */
export async function cli(argv: string[], options: Parameters<typeof createApp>[0] & { answers?: string[] } = {}) {
  const app = createApp(options)
  const io = new BufferedIO(options.answers)
  app.instance(ConsoleIO, io)
  const code = await new CliKernel(app).run(argv)
  return { code, out: io.out, app }
}

export const BIN = `${import.meta.dir}/../src/bin.ts`
export const FIXTURE = `${import.meta.dir}/fixture`

/** A throwaway database (from DATABASE_URL), or undefined. */
export async function tempDatabase() {
  const url = process.env.DATABASE_URL
  if (!url) return undefined
  const name = `cslug_cli_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const conn = new SQL(admin.toString(), { max: 1 })
  await conn.unsafe(`create database "${name}"`)
  const u = new URL(url)
  u.pathname = `/${name}`
  return {
    url: u.toString(),
    drop: async () => {
      await conn.unsafe(`drop database if exists "${name}" with (force)`)
      await conn.close()
    },
  }
}

/** A port the OS says is free right now (bound on port 0, then released), not a random guess that may be taken. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = probe.port as number
  probe.stop(true)
  return port
}

export async function waitFor(check: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return
    await Bun.sleep(50)
  }
  throw new Error('timed out waiting')
}
