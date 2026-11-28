import type { MiddlewareFn } from '@cslug/http'

export type CspOptions = {
  /** Sources per directive, replacing the default's; `false` removes a directive. */
  directives?: Record<string, string[] | false>
  /** Send `Content-Security-Policy-Report-Only`: the browser reports what it would block, and blocks nothing. */
  reportOnly?: boolean
  /** Where browsers post violation reports (`report-uri`). */
  reportUri?: string
}

const DEFAULTS: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  // Vue's :style bindings render style attributes; inline <style> and <script> still need the nonce
  'style-src-attr': ["'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
}

/** The policy text for a nonce. */
export function cspPolicy(nonce: string, options: CspOptions = {}, production = false): string {
  const directives: Record<string, string[] | false> = { ...DEFAULTS, ...options.directives }
  if (production && !('upgrade-insecure-requests' in (options.directives ?? {})))
    directives['upgrade-insecure-requests'] = []
  if (options.reportUri) directives['report-uri'] = [options.reportUri]
  const parts: string[] = []
  for (const [name, sources] of Object.entries(directives)) {
    if (sources === false) continue
    const all = name === 'script-src' || name === 'style-src' ? [...sources, `'nonce-${nonce}'`] : sources
    parts.push([name, ...all].join(' '))
  }
  return parts.join('; ')
}

/** 16 random bytes, base64. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
}

/**
 * A Content-Security-Policy with a new nonce per request: `ctx.nonce`, which `<Assets>` (@cslug/vue) adds to its
 * tags. The header is on error responses too; a response that sets its own policy keeps it.
 */
export const csp =
  (options: CspOptions = {}): MiddlewareFn =>
  (ctx, next) => {
    const nonce = newNonce()
    ctx.nonce = nonce
    const header = options.reportOnly ? 'content-security-policy-report-only' : 'content-security-policy'
    ctx.response.headers.set(header, cspPolicy(nonce, options, ctx.app.config('app.env') === 'production'))
    return next()
  }
