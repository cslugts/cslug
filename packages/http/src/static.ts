import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

/** Hashed build output (`client-3f9a1c2e.js`): cached for a year. */
const HASHED = /-[a-z0-9]{8}\.[a-z0-9]+$/

/**
 * A file from `public/` for a GET/HEAD that matched no route, or undefined. Dotfiles and paths escaping the
 * folder are refused. `If-Modified-Since` gets a 304.
 */
export function serveStatic(publicDir: string, pathname: string, request: Request): Response | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) return undefined
  const file = normalize(join(publicDir, decoded))
  if (!file.startsWith(publicDir.endsWith(sep) ? publicDir : publicDir + sep) || !existsSync(file)) return undefined
  const stat = statSync(file)
  if (!stat.isFile()) return undefined
  const modified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000)
  const headers = new Headers({
    'last-modified': modified.toUTCString(),
    'cache-control': HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
  })
  const since = request.headers.get('if-modified-since')
  if (since && new Date(since).getTime() >= modified.getTime()) return new Response(null, { status: 304, headers })
  const body = Bun.file(file)
  headers.set('content-type', body.type)
  headers.set('content-length', String(stat.size))
  return new Response(request.method === 'HEAD' ? null : body, { headers })
}
