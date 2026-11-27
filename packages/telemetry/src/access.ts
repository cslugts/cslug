import { timingSafeEqual } from 'node:crypto'

/** IPv4 as a 32-bit number (`::ffff:1.2.3.4` too), or undefined. */
function ipv4(ip: string): number | undefined {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim())
  if (!m) return undefined
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return undefined
  return parts.reduce((n, p) => n * 256 + p, 0)
}

/** Whether `ip` is in the list: exact addresses (IPv4 or IPv6) and IPv4 CIDR ranges (`10.0.0.0/8`). */
export function ipAllowed(ip: string | undefined, allow: readonly string[]): boolean {
  if (!ip) return false
  const address = ipv4(ip)
  return allow.some((entry) => {
    const [range, bits] = entry.split('/') as [string, string | undefined]
    const base = ipv4(range)
    if (base === undefined || address === undefined) return !bits && range.toLowerCase() === ip.toLowerCase()
    const size = bits === undefined ? 32 : Number(bits)
    if (!Number.isInteger(size) || size < 0 || size > 32) return false
    const block = 2 ** (32 - size)
    return Math.floor(address / block) === Math.floor(base / block)
  })
}

/** `Authorization: Bearer <token>` compared in constant time. */
export function bearerMatches(header: string | null, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const LOOPBACK = ['127.0.0.1', '::1']
