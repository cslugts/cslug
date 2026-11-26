#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Application } from '@cslug/core'
import { CliKernel } from './kernel'

/** The app root: the nearest folder (from the cwd up) with bootstrap/app.ts. */
function findRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'bootstrap/app.ts'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

const root = findRoot(process.cwd())
let app: Application
try {
  app = root ? (await import(join(root, 'bootstrap/app.ts'))).createApp() : new Application({ root: process.cwd() })
} catch (error) {
  // usually env validation (EnvError lists every problem)
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
const kernel = new CliKernel(app)
const code = await kernel.run(process.argv.slice(2))
// long-running commands (serve, start, queue:work) keep the process alive until a signal
if (!kernel.keepAlive) process.exit(code)
