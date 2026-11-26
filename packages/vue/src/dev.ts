import { watch } from 'node:fs'
import { join } from 'node:path'
import { type Application, Logger } from '@cslug/core'
import type { RouteRegistrar } from '@cslug/http'
import { buildAssets } from './build'

const LIVE = '/__cslug/live'
let enabled = false
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()

/** The live-reload endpoint when `cslug dev` runs (CSLUG_DEV=1), else undefined. */
export const liveReloadUrl = () => (enabled ? LIVE : undefined)

function broadcast(event: 'reload' | 'css'): void {
  const chunk = new TextEncoder().encode(`event: ${event}\ndata: {}\n\n`)
  for (const c of clients) {
    try {
      c.enqueue(chunk)
    } catch {
      clients.delete(c)
    }
  }
}

/**
 * Development: build the assets now, rebuild when resources/ changes, and tell open pages to reload (CSS-only
 * changes swap the stylesheets). Server-side `.vue` changes restart the process (`bun --watch`); pages reconnect
 * and reload.
 */
export async function startDev(app: Application, options: Parameters<typeof buildAssets>[0]): Promise<() => void> {
  enabled = true
  const log = app.resolve(Logger)
  const rebuild = async (css: boolean) => {
    try {
      const { ms } = await buildAssets(options)
      log.info('vue.assets_built', { ms })
      broadcast(css ? 'css' : 'reload')
    } catch (error) {
      log.error('vue.assets_failed', { error })
    }
  }
  await rebuild(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(join(app.rootDir, 'resources'), { recursive: true }, (_event, file) => {
    clearTimeout(timer)
    timer = setTimeout(() => rebuild(/\.(s?css)$/.test(String(file))), 50)
  })
  return () => {
    watcher.close()
    for (const c of clients) c.close()
    clients.clear()
    enabled = false
  }
}

/** The SSE route pages connect to. */
export function liveRoute(r: RouteRegistrar): void {
  r.get(LIVE, () => {
    let self: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller
        clients.add(controller)
        controller.enqueue(new TextEncoder().encode(': connected\n\n'))
      },
      cancel() {
        clients.delete(self)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  })
}
