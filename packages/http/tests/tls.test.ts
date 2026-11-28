import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { Application, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider, tlsFiles } from '../src'

const dir = join(import.meta.dir, 'fixtures/tls')
const files = { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') }

const app = async () => {
  const a = new Application({ root: '/nonexistent', configs: { http: { port: 0 } } })
  a.useProviders([HttpProvider])
  a.singleton(Logger, () => Logger.null())
  await a.start()
  return a
}

test('listen({ tls }) serves HTTPS with the given certificate', async () => {
  const a = await app()
  const server = a.resolve(HttpKernel).listen({ port: 0, tls: files })
  try {
    expect(server.url.protocol).toBe('https:')
    const res = await fetch(`https://localhost:${server.port}/health/live`, { tls: { rejectUnauthorized: false } })
    expect(await res.json()).toEqual({ status: 'ok' })
  } finally {
    await a.shutdown()
  }
})

test('a missing certificate or key file is named in the error', async () => {
  const a = await app()
  const kernel = a.resolve(HttpKernel)
  expect(() => kernel.listen({ port: 0, tls: { ...files, cert: '/nope/cert.pem' } })).toThrow(
    'TLS certificate not found: /nope/cert.pem',
  )
  expect(() => kernel.listen({ port: 0, tls: { ...files, key: '/nope/key.pem' } })).toThrow('TLS key not found')
  await a.shutdown()
})

test('tlsFiles: flags, then http.tls, then TLS_CERT / TLS_KEY; a half-given pair is an error', () => {
  const env = { TLS_CERT: 'env.pem', TLS_KEY: 'env-key.pem' }
  const config = { cert: 'config.pem', key: 'config-key.pem' }
  expect(tlsFiles(undefined, {}, {})).toBeUndefined()
  expect(tlsFiles(undefined, {}, env)).toEqual({ cert: 'env.pem', key: 'env-key.pem' })
  expect(tlsFiles(config, {}, env)).toEqual({ cert: 'config.pem', key: 'config-key.pem' })
  expect(tlsFiles(config, { cert: 'flag.pem', key: 'flag-key.pem' }, env)).toEqual({
    cert: 'flag.pem',
    key: 'flag-key.pem',
  })
  expect(tlsFiles(undefined, { cert: 'flag.pem' }, env)).toBe(
    'HTTPS needs a certificate and a key: --tls-cert / --tls-key gives only the certificate',
  )
  expect(tlsFiles({ key: 'k.pem' }, {}, {})).toContain('http.tls gives only the key')
})
