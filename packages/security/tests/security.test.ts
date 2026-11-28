import { describe, expect, test } from 'bun:test'
import { Application, CslugError, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider, Router } from '@cslug/http'
import { csp, cspPolicy, ipFilter, ipInRange, SecurityProvider, securityTxt } from '../src'

async function app(security: Record<string, unknown> | undefined, env = 'test') {
  const app = new Application({
    root: '/nonexistent-cslug-test-root',
    configs: {
      app: { name: 'Demo', env, url: 'https://example.test', key: 'k'.repeat(32) },
      ...(security ? { security } : {}),
    },
  })
  app.useProviders([HttpProvider, SecurityProvider])
  app.singleton(Logger, () => Logger.null())
  await app.start()
  app.resolve(Router).load((r) => {
    r.get('/page', (ctx) => ({ nonce: ctx.nonce }))
    r.get('/own-policy', () => new Response('x', { headers: { 'content-security-policy': "default-src 'none'" } }))
    r.get('/broken', () => {
      throw new Error('boom')
    })
    r.group({ prefix: '/admin', middleware: [ipFilter({ allow: ['10.0.0.0/8'] })] }, (r) => {
      r.get('/', () => 'admin')
    })
  })
  const kernel = app.resolve(HttpKernel).compile()
  const call = (path: string, ip = '203.0.113.7') =>
    kernel.handle(new Request(new URL(path, 'https://example.test')), { ip })
  return { app, call }
}

describe('csp()', () => {
  test('a new nonce on every request, in the header and on ctx.nonce', async () => {
    const { call } = await app(undefined)
    const a = await call('/page')
    const b = await call('/page')
    const nonceA = ((await a.json()) as { nonce: string }).nonce
    const nonceB = ((await b.json()) as { nonce: string }).nonce
    expect(nonceA).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(nonceA).not.toBe(nonceB)
    const policy = a.headers.get('content-security-policy') as string
    expect(policy).toContain(`script-src 'self' 'nonce-${nonceA}'`)
    expect(policy).toContain(`style-src 'self' 'nonce-${nonceA}'`)
    expect(policy).toContain("style-src-attr 'unsafe-inline'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('upgrade-insecure-requests') // production only
  })

  test('on error responses too; a response with its own policy keeps it', async () => {
    const { call } = await app(undefined)
    const broken = await call('/broken')
    expect(broken.status).toBe(500)
    expect(broken.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect((await call('/missing')).headers.get('content-security-policy')).toContain("default-src 'self'")
    expect((await call('/own-policy')).headers.get('content-security-policy')).toBe("default-src 'none'")
  })

  test('directives replace the defaults or remove them; report-only; production upgrades requests', async () => {
    const policy = cspPolicy(
      'abc',
      { directives: { 'img-src': ["'self'", 'https://img.example.com'], 'font-src': false }, reportUri: '/csp' },
      true,
    )
    expect(policy).toContain("img-src 'self' https://img.example.com")
    expect(policy).not.toContain('font-src')
    expect(policy).toContain('upgrade-insecure-requests; report-uri /csp')

    const { call } = await app({ csp: { reportOnly: true } })
    const res = await call('/page')
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('content-security-policy-report-only')).toContain("'nonce-")
  })

  test('csp: false turns it off; csp() then works on a group', async () => {
    const { app: a, call } = await app({ csp: false })
    expect((await call('/page')).headers.get('content-security-policy')).toBeNull()
    a.resolve(Router).load((r) => r.group({ middleware: [csp()] }, (r) => r.get('/strict', () => 'ok')))
    a.resolve(HttpKernel).compile()
    expect((await call('/strict')).headers.get('content-security-policy')).toContain("'nonce-")
  })
})

describe('IP filter and per-IP limit', () => {
  test('ipInRange: addresses and CIDR ranges, IPv4, IPv6 and IPv4-mapped', () => {
    expect(ipInRange('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(ipInRange('11.0.0.1', ['10.0.0.0/8'])).toBe(false)
    expect(ipInRange('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(ipInRange('192.168.1.10', ['192.168.1.10'])).toBe(true)
    expect(ipInRange('192.168.1.11', ['192.168.1.10/32'])).toBe(false)
    expect(ipInRange('1.2.3.4', ['0.0.0.0/0'])).toBe(true)
    expect(ipInRange('2001:db8:abcd::1', ['2001:db8::/32'])).toBe(true)
    expect(ipInRange('2001:db9::1', ['2001:db8::/32'])).toBe(false)
    expect(ipInRange('::1', ['::1'])).toBe(true)
    expect(ipInRange('fe80::1%eth0', ['fe80::/10'])).toBe(true)
    expect(ipInRange('2001:0db8:0000:0000:0000:0000:0000:0001', ['2001:db8::1'])).toBe(true)
    expect(ipInRange('::ffff:1.2.3.4', ['::ffff:1.2.3.0/120'])).toBe(false) // mapped addresses compare as IPv4
    expect(ipInRange('10.0.0.1', ['::/0'])).toBe(false) // families never mix
    expect(ipInRange(undefined, ['0.0.0.0/0'])).toBe(false)
    expect(ipInRange('not-an-ip', ['0.0.0.0/0'])).toBe(false)
    expect(ipInRange('1.2.3.4', ['1.2.3.0/33', 'garbage'])).toBe(false)
    expect(ipInRange('1:2:3:4:5:6:7:8:9', ['::/0'])).toBe(false)
  })

  test('deny wins, allow lets only those in; on a group', async () => {
    const { call } = await app({ ipFilter: { deny: ['203.0.113.0/24'] } })
    const denied = await call('/page')
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { code: string }).code).toBe('security.ip_denied')
    expect((await call('/page', '198.51.100.1')).status).toBe(200)
    expect((await call('/admin', '198.51.100.1')).status).toBe(403)
    expect((await call('/admin', '10.0.0.5')).status).toBe(200)

    const { call: only } = await app({ ipFilter: { allow: ['2001:db8::/32'] } })
    expect((await only('/page', '2001:db8::5')).status).toBe(200)
    expect((await only('/page', '198.51.100.1')).status).toBe(403)
  })

  test('limit: 429 past it per IP, other IPs and health checks unaffected', async () => {
    const { call } = await app({ limit: '3/min' })
    for (let i = 0; i < 3; i++) expect((await call('/page')).status).toBe(200)
    const over = await call('/page')
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await call('/page', '198.51.100.1')).status).toBe(200)
    expect((await call('/health/live')).status).toBe(200)
  })
})

describe('security.txt', () => {
  test('served as text, with Expires and Canonical defaults', async () => {
    const { call } = await app({
      securityTxt: {
        contact: ['mailto:security@example.test', 'https://example.test/report'],
        policy: 'https://example.test/security',
        preferredLanguages: ['en', 'fr'],
      },
    })
    const res = await call('/.well-known/security.txt')
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const body = await res.text()
    const lines = body.trim().split('\n')
    expect(lines[0]).toBe('Contact: mailto:security@example.test')
    expect(lines[1]).toBe('Contact: https://example.test/report')
    const expires = new Date(body.match(/^Expires: (.+)$/m)?.[1] as string).getTime()
    expect(expires - Date.now()).toBeGreaterThan(364 * 86_400_000)
    expect(body).toContain('Preferred-Languages: en, fr\n')
    expect(body).toContain('Policy: https://example.test/security\n')
    expect(body).toEndWith('Canonical: https://example.test/.well-known/security.txt\n')
  })

  test('not served without config; a contact is required; expires is a date', async () => {
    const { call } = await app({})
    expect((await call('/.well-known/security.txt')).status).toBe(404)
    const expires = new Date('2027-01-01T00:00:00Z')
    expect(() => securityTxt({ contact: [] }, { expires })).toThrow(CslugError)
    expect(() => securityTxt({ contact: 'mailto:a@b.c', expires: 'soon' }, { expires })).toThrow(CslugError)
    expect(securityTxt({ contact: 'mailto:a@b.c', expires: '2027-06-30' }, { expires })).toBe(
      'Contact: mailto:a@b.c\nExpires: 2027-06-30T00:00:00.000Z\n',
    )
  })
})
