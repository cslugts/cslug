import { Clock, CslugError, currentApp, type Duration, parseDuration, UnauthorizedError } from '@cslug/core'
import type { HttpContext, HttpRequest, MiddlewareFn } from '@cslug/http'

/** One sender in `config/webhooks.ts`. */
export type WebhookSource = {
  secret: string
  /** The header carrying the signature (`X-Signature`). */
  header: string
  algorithm?: 'sha1' | 'sha256' | 'sha512'
  /**
   * How the header reads, with `{signature}` and optionally `{timestamp}` (`'t={timestamp},v1={signature}'`).
   * With a timestamp, `${timestamp}.${rawBody}` is signed. Default `'{signature}'`.
   */
  format?: string
  /** How the signature is written. Default `'hex'`. */
  encoding?: 'hex' | 'base64'
  /** With `{timestamp}`: requests older (or newer) than this are rejected. Default `'5m'`. */
  tolerance?: Duration
}

/** Your own scheme: `verifySignature((req, raw) => mySdk.verify(raw, req.headers))`. */
export type SignatureCheck = (request: HttpRequest, raw: Uint8Array) => boolean | Promise<boolean>

const HASH = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512' } as const
const encoder = new TextEncoder()

function sourceConfig(name: string): WebhookSource {
  const source = currentApp().config<WebhookSource | undefined>(`webhooks.${name}`)
  if (!source?.secret || !source.header)
    throw new CslugError('webhook.no_source', `config/webhooks.ts has no source "${name}" with a secret and a header`)
  return source
}

const key = (secret: string, algorithm: keyof typeof HASH, usage: KeyUsage) =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: HASH[algorithm] }, false, [usage])

/** The signed bytes: the raw body, or `${timestamp}.${rawBody}`. */
const signed = (raw: Uint8Array, timestamp?: string): Uint8Array<ArrayBuffer> =>
  timestamp === undefined ? new Uint8Array(raw) : new Uint8Array([...encoder.encode(`${timestamp}.`), ...raw])

const decode = (text: string, encoding: 'hex' | 'base64'): Uint8Array<ArrayBuffer> | undefined => {
  if (encoding === 'base64') return Uint8Array.from(Buffer.from(text, 'base64'))
  return /^([0-9a-f]{2})+$/i.test(text) ? Uint8Array.from(Buffer.from(text, 'hex')) : undefined
}

/** `{timestamp}` and `{signature}` out of a header written in `format`. */
function parseHeader(header: string, format: string): { signature?: string; timestamp?: string } {
  const pattern = format
    .split(/(\{signature\}|\{timestamp\})/)
    .map((part) =>
      part === '{signature}'
        ? '(?<signature>[A-Za-z0-9+/=_-]+)'
        : part === '{timestamp}'
          ? '(?<timestamp>\\d+)'
          : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('')
  return new RegExp(`^${pattern}$`).exec(header.trim())?.groups ?? {}
}

/**
 * Check a webhook request against `config/webhooks.ts` → `name`: HMAC over the raw bytes, compared in constant
 * time (`crypto.subtle.verify`), and the timestamp within `tolerance`. True when valid.
 */
export async function checkSignature(name: string, request: HttpRequest): Promise<boolean> {
  const source = sourceConfig(name)
  const header = request.header(source.header)
  if (!header) return false
  const { signature, timestamp } = parseHeader(header, source.format ?? '{signature}')
  if (!signature) return false
  if (timestamp !== undefined) {
    const now = currentApp().resolve(Clock).now().getTime()
    if (Math.abs(now - Number(timestamp) * 1000) > parseDuration(source.tolerance ?? '5m')) return false
  }
  const bytes = decode(signature, source.encoding ?? 'hex')
  if (!bytes) return false
  const raw = await request.raw()
  const hmac = await key(source.secret, source.algorithm ?? 'sha256', 'verify')
  return crypto.subtle.verify('HMAC', hmac, bytes, signed(raw, timestamp))
}

/**
 * Middleware: 401 unless the request is signed by the sender `name` (config/webhooks.ts), or your own check passes.
 * Reads the raw body first; `request.body()` still works afterwards (the bytes are cached).
 *
 * ```ts
 * r.post('/webhooks/payments', [PaymentWebhookController, 'handle']).middleware(verifySignature('payments'))
 * ```
 */
export function verifySignature(source: string | SignatureCheck): MiddlewareFn {
  return async (ctx: HttpContext, next) => {
    const ok =
      typeof source === 'string'
        ? await checkSignature(source, ctx.request)
        : await source(ctx.request, await ctx.request.raw())
    if (!ok) throw new UnauthorizedError('webhook.bad_signature', 'The webhook signature is missing or invalid.')
    return next()
  }
}

/**
 * Headers that sign `rawBody` as the sender `name` would (for tests):
 * `t.post('/webhooks/payments').headers(await signWebhook('payments', JSON.stringify(event))).json(event)`.
 */
export async function signWebhook(
  name: string,
  rawBody: string | Uint8Array,
  options: { timestamp?: number } = {},
): Promise<Record<string, string>> {
  const source = sourceConfig(name)
  const format = source.format ?? '{signature}'
  const raw = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody
  const timestamp = format.includes('{timestamp}')
    ? String(options.timestamp ?? Math.floor(currentApp().resolve(Clock).now().getTime() / 1000))
    : undefined
  const hmac = await key(source.secret, source.algorithm ?? 'sha256', 'sign')
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', hmac, signed(raw, timestamp)))
  const signature = mac.toString(source.encoding === 'base64' ? 'base64' : 'hex')
  return {
    [source.header]: format.replace('{signature}', signature).replace('{timestamp}', timestamp ?? ''),
  }
}
