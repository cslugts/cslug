import { ForbiddenError } from '@cslug/core'
import type { MiddlewareFn } from '@cslug/http'

type Address = { v6: boolean; n: bigint }

function ipv4(text: string): bigint | undefined {
  const parts = text.split('.')
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return undefined
  return parts.reduce((n, p) => n * 256n + BigInt(p), 0n)
}

function ipv6(text: string): bigint | undefined {
  let groups = text
  let tail: bigint | undefined
  // an embedded IPv4 address at the end: ::ffff:1.2.3.4
  const v4 = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(groups)
  if (v4) {
    tail = ipv4(v4[1] as string)
    if (tail === undefined) return undefined
    groups = `${groups.slice(0, groups.length - (v4[1] as string).length)}0:0`
  }
  const halves = groups.split('::')
  if (halves.length > 2) return undefined
  const split = (s: string) => (s ? s.split(':') : [])
  const head = split(halves[0] as string)
  const rest = halves.length === 2 ? split(halves[1] as string) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined
  const n = all.reduce((acc, g) => (acc << 16n) | BigInt(Number.parseInt(g, 16)), 0n)
  return tail === undefined ? n : (n & ~0xffffffffn) | tail
}

/** An address as a number; IPv4-mapped IPv6 (`::ffff:1.2.3.4`) counts as IPv4. */
function parse(ip: string): Address | undefined {
  const text = ip
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
  const four = ipv4(text)
  if (four !== undefined) return { v6: false, n: four }
  const six = text.includes(':') ? ipv6(text) : undefined
  if (six === undefined) return undefined
  if (six >> 32n === 0xffffn) return { v6: false, n: six & 0xffffffffn }
  return { v6: true, n: six }
}

/** Whether `ip` is one of `ranges`: addresses or CIDR ranges, IPv4 or IPv6 (`10.0.0.0/8`, `2001:db8::/32`). */
export function ipInRange(ip: string | undefined, ranges: readonly string[]): boolean {
  const address = ip ? parse(ip) : undefined
  if (!address) return false
  return ranges.some((entry) => {
    const [base, bits] = entry.split('/') as [string, string | undefined]
    const range = parse(base)
    if (!range || range.v6 !== address.v6) return false
    const width = address.v6 ? 128 : 32
    const size = bits === undefined ? width : Number(bits)
    if (!Number.isInteger(size) || size < 0 || size > width) return false
    const shift = BigInt(width - size)
    return address.n >> shift === range.n >> shift
  })
}

export type IpFilterOptions = {
  /** Only these addresses and ranges get in. */
  allow?: string[]
  /** These never do (checked first). */
  deny?: string[]
}

/** 403 `security.ip_denied` for an address in `deny`, or outside `allow` when it is given. */
export const ipFilter =
  (options: IpFilterOptions): MiddlewareFn =>
  (ctx, next) => {
    const ip = ctx.request.ip()
    if ((options.deny && ipInRange(ip, options.deny)) || (options.allow && !ipInRange(ip, options.allow)))
      throw new ForbiddenError('security.ip_denied', 'Access from this address is not allowed.')
    return next()
  }
