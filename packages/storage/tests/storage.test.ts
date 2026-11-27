import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application, Logger } from '@cslug/core'
import { HttpKernel, HttpProvider } from '@cslug/http'
import { testApp } from '@cslug/testing'
import {
  checkKey,
  type Disk,
  FileNotFoundError,
  installStorageFake,
  LocalDisk,
  MemoryDisk,
  S3Disk,
  Storage,
  StorageProvider,
  UploadRejectedError,
} from '../src'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n')
const root = mkdtempSync(join(tmpdir(), 'cslug-storage-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('keys are relative paths without . or .. segments', () => {
  for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a/'])
    expect(() => checkKey(bad)).toThrow('Invalid storage key')
  expect(checkKey('operators/7/licence/a.pdf')).toBe('operators/7/licence/a.pdf')
})

const S3 = process.env.S3_ENDPOINT
const drivers: [string, () => Disk][] = [
  ['local', () => new LocalDisk('local', root)],
  ['memory', () => new MemoryDisk('memory')],
]
if (S3) drivers.push(['s3', () => new S3Disk('s3', { endpoint: S3, bucket: process.env.S3_BUCKET ?? 'cslug' })])

describe.each(drivers)('%s disk', (_, make) => {
  const disk = make()
  const prefix = `t-${Bun.randomUUIDv7()}`

  test('put, get, text, exists, stat, delete', async () => {
    const key = `${prefix}/notes/a.txt`
    expect(await disk.exists(key)).toBe(false)
    await disk.put(key, 'héllo', { type: 'text/plain' })
    expect(await disk.exists(key)).toBe(true)
    expect(await disk.text(key)).toBe('héllo')
    expect(await disk.get(key)).toEqual(new TextEncoder().encode('héllo'))
    expect((await disk.stat(key)).size).toBe(6)
    expect(await new Response(await disk.stream(key)).text()).toBe('héllo')
    await disk.delete(key)
    await disk.delete(key) // deleting a missing key is fine
    expect(await disk.exists(key)).toBe(false)
  })

  test('a missing key is FileNotFoundError (404)', async () => {
    const error = await disk.get(`${prefix}/missing.txt`).catch((e) => e)
    expect(error).toBeInstanceOf(FileNotFoundError)
    expect(error.status).toBe(404)
    expect(disk.stat(`${prefix}/missing.txt`)).rejects.toBeInstanceOf(FileNotFoundError)
  })

  test('putFile: generated uuidv7 name, extension from the sniffed bytes (not the client)', async () => {
    const upload = new File([PNG], '../../evil.exe', { type: 'application/x-msdownload' })
    const key = await disk.putFile(`${prefix}/operators/7/licence/`, upload)
    expect(key).toMatch(new RegExp(`^${prefix}/operators/7/licence/[0-9a-f-]{36}\\.png$`))
    expect(await disk.get(key)).toEqual(PNG)
    const text = await disk.putFile(`${prefix}/docs`, new File(['a,b'], 'list.CSV', { type: 'text/csv' }))
    expect(text).toEndWith('.csv')
  })

  test('verifyUpload: size and type from the bytes; a refused file is deleted', async () => {
    await disk.put(`${prefix}/u/ok.pdf`, PDF, { type: 'application/pdf' })
    expect(await disk.verifyUpload(`${prefix}/u/ok.pdf`, { maxSize: '1kb', types: ['application/pdf'] })).toEqual({
      size: PDF.byteLength,
      type: 'application/pdf',
    })

    await disk.put(`${prefix}/u/fake.pdf`, PNG, { type: 'application/pdf' }) // declared PDF, bytes are PNG
    const wrong = await disk.verifyUpload(`${prefix}/u/fake.pdf`, { types: ['application/pdf'] }).catch((e) => e)
    expect(wrong).toBeInstanceOf(UploadRejectedError)
    expect(wrong.code).toBe('storage.upload_type')
    expect(await disk.exists(`${prefix}/u/fake.pdf`)).toBe(false)

    await disk.put(`${prefix}/u/big.pdf`, PDF)
    const big = await disk.verifyUpload(`${prefix}/u/big.pdf`, { maxSize: 4 }).catch((e) => e)
    expect(big.code).toBe('storage.upload_too_large')
    expect(await disk.exists(`${prefix}/u/big.pdf`)).toBe(false)
  })
})

describe.skipIf(!S3)('s3 disk: presigned URLs', () => {
  const disk = new S3Disk('s3', { endpoint: S3, bucket: process.env.S3_BUCKET ?? 'cslug' })

  test('a presigned download, as an attachment', async () => {
    await disk.put('presigned/a.pdf', PDF, { type: 'application/pdf' })
    const url = await disk.signedUrl('presigned/a.pdf', { expiresIn: '5m', download: 'Licence.pdf' })
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Licence.pdf"')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF)
  })

  test('a presigned direct upload, then verifyUpload', async () => {
    const { url, method, headers } = await disk.signedUploadUrl('presigned/up.pdf', {
      expiresIn: '5m',
      type: 'application/pdf',
    })
    expect((await fetch(url, { method, headers, body: PDF })).ok).toBe(true)
    expect((await disk.verifyUpload('presigned/up.pdf', { maxSize: '1mb', types: ['application/pdf'] })).type).toBe(
      'application/pdf',
    )
  })
})

/** An app with StorageProvider (and HttpProvider unless `http: false`) and a local disk in a temp dir. */
async function storageApp(http = true, start = true) {
  const app = new Application({
    root,
    configs: {
      app: { url: 'https://example.test', key: 'k'.repeat(32), env: 'test' },
      storage: {
        default: 'local',
        disks: { local: { driver: 'local', root: 'files' }, scratch: { driver: 'memory' } },
      },
    },
  })
  app.useProviders(http ? [HttpProvider, StorageProvider] : [StorageProvider])
  app.singleton(Logger, () => Logger.null())
  if (start) await app.start()
  return app
}

describe('StorageProvider and local signed URLs (guide 17)', async () => {
  const app = await storageApp()
  const storage = app.resolve(Storage)
  const kernel = app.resolve(HttpKernel).compile()
  const call = (url: string, init?: RequestInit) => kernel.handle(new Request(url, init))

  test('disks from config/storage.ts; relative roots under the app root', async () => {
    expect(storage.names()).toEqual(['local', 'scratch'])
    expect((storage.disk() as LocalDisk).root).toBe(join(root, 'files'))
    expect(storage.disk('scratch')).toBeInstanceOf(MemoryDisk)
    expect(() => storage.disk('nope')).toThrow('No disk "nope"')
  })

  test('a signed download is served; a changed or unsigned link is 403', async () => {
    const key = await storage.putFile('operators/7/licence', new File([PDF], 'licence.pdf'))
    const url = await storage.signedUrl(key, { expiresIn: '5m', download: 'Licence "7".pdf' })
    expect(url).toStartWith('https://example.test/_storage/local?')
    const res = await call(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Licence _7_.pdf"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF)

    expect((await call(url.replace('licence', 'other'))).status).toBe(403)
    expect((await call(url.replace(/&signature=[^&]+/, ''))).status).toBe(403)
  })

  test('a signed upload link: PUT with the signed type and size; a download link cannot upload', async () => {
    const up = await storage.signedUploadUrl('uploads/a.pdf', { expiresIn: '5m', type: 'application/pdf', maxSize: 64 })
    expect(up.method).toBe('PUT')

    expect((await call(up.url, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG })).status).toBe(
      415,
    )
    expect((await call(up.url, { method: 'PUT', headers: up.headers, body: new Uint8Array(65) })).status).toBe(413)
    expect((await call(up.url, { method: 'PUT', headers: up.headers, body: PDF })).status).toBe(204)
    expect((await storage.verifyUpload('uploads/a.pdf', { types: ['application/pdf'] })).size).toBe(PDF.byteLength)

    expect((await call(up.url)).status).toBe(403) // an upload link is not a download link
    const download = await storage.signedUrl('uploads/a.pdf', { expiresIn: '5m' })
    expect((await call(download, { method: 'PUT', headers: up.headers, body: PDF })).status).toBe(403)
  })

  test('a signed link to a missing file is 404', async () => {
    expect((await call(await storage.signedUrl('nothing/here.pdf', { expiresIn: '5m' }))).status).toBe(404)
  })
})

test('without @cslug/http, local signed URLs explain what is missing', async () => {
  const storage = (await storageApp(false)).resolve(Storage)
  expect(storage.signedUrl('a.pdf', { expiresIn: '5m' })).rejects.toThrow('need @cslug/http')
})

describe('the storage fake', () => {
  test('installStorageFake: every disk in memory; assertExists / assertMissing', async () => {
    const app = await storageApp(false)
    const fake = installStorageFake(app)
    expect(app.resolve(Storage)).toBe(fake)
    const key = await app.resolve(Storage).putFile('operators/7/licence', new File([PDF], 'l.pdf'))
    fake.assertExists(key)
    fake.assertExists('operators/7/licence/')
    fake.assertMissing('operators/8/')
    expect(() => fake.assertExists('operators/8/')).toThrow('Expected a file at "operators/8/"')
    expect(() => fake.assertMissing('operators/7/')).toThrow('Expected no file')
    fake.disk('scratch').put('x', 'y')
    expect(fake.keys('scratch')).toEqual(['x'])
  })

  describe('testApp({ fakes: ["storage"] })', () => {
    const t = testApp({ create: () => storageApp(false, false), fakes: ['storage'] })
    test('t.storage', async () => {
      await t.app.resolve(Storage).put('a.txt', 'a')
      t.storage.assertExists('a.txt')
    })
  })
})
