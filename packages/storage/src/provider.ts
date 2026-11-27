import { AppError, CslugError, Encrypter, ForbiddenError, ServiceProvider } from '@cslug/core'
import type { HttpContext } from '@cslug/http'
import { FileNotFoundError } from './disk'
import { LocalDisk, type LocalSigner } from './drivers'
import { createDisk, DEFAULT_DISKS, Storage, type StorageConfig } from './storage'

type HttpModule = typeof import('@cslug/http')

/**
 * Binds `Storage` from `config/storage.ts`. With @cslug/http installed, local disks get signed URLs served at
 * `/_storage/:disk` (route `storage.file`): GET downloads, PUT receives a direct upload.
 */
export class StorageProvider extends ServiceProvider {
  private signer?: LocalSigner

  register() {
    this.app.singleton(Storage, () => {
      const config = this.app.config<StorageConfig | undefined>('storage') ?? {}
      const defs = config.disks ?? DEFAULT_DISKS
      const disks = new Map(Object.entries(defs).map(([name, c]) => [name, createDisk(name, c, this.app.rootDir)]))
      for (const disk of disks.values())
        if (disk instanceof LocalDisk) disk.signer = (query, options) => this.sign(disk.name, query, options)
      return new Storage(disks, config.default ?? Object.keys(defs)[0] ?? 'local')
    })
  }

  async boot() {
    const http = await import('@cslug/http').catch(() => undefined)
    if (!http || !this.app.has(http.Router)) return
    const router = this.app.resolve(http.Router)
    router.load((r) => {
      r.get('/_storage/:disk', (ctx) => this.serve(http, ctx)).name('storage.file')
      r.put('/_storage/:disk', (ctx) => this.serve(http, ctx))
    })
    this.signer = (query, options) =>
      http.urlFor(
        router,
        this.app.config<string | undefined>('app.url'),
        this.app.resolve(Encrypter),
        'storage.file',
        query,
        { signed: true, expiresIn: options.expiresIn },
      )
  }

  private sign(disk: string, query: Record<string, string>, options: Parameters<LocalSigner>[1]): string {
    if (!this.signer)
      throw new CslugError('storage.no_http', `Signed URLs on the local disk "${disk}" need @cslug/http`)
    return this.signer(query, options)
  }

  private async serve(http: HttpModule, ctx: HttpContext): Promise<Response> {
    if (!http.verifySignedUrl(ctx.request.url.toString(), this.app.resolve(Encrypter)))
      throw new ForbiddenError('http.invalid_signature', 'This link is invalid or has expired.')
    const disk = this.app.resolve(Storage).disk(ctx.params.disk)
    if (!(disk instanceof LocalDisk)) throw new FileNotFoundError('')
    const file = ctx.request.query('key') ?? ''
    const upload = ctx.request.query('upload') // the signed content type of an upload link
    if (ctx.request.method === 'PUT') {
      if (!upload) throw new ForbiddenError('storage.not_an_upload_link', 'This link does not accept uploads.')
      if (ctx.request.header('content-type') !== upload)
        throw new AppError('storage.upload_type', `The upload must be sent as ${upload}`, { status: 415 })
      const body = await ctx.request.raw()
      const max = ctx.request.query('max')
      if (max !== undefined && body.byteLength > Number(max))
        throw new AppError('storage.upload_too_large', 'File too large', { status: 413 })
      await disk.put(file, body)
      return new Response(null, { status: 204 })
    }
    if (upload) throw new ForbiddenError('storage.upload_link', 'This link is for uploading.')
    if (!(await disk.exists(file))) throw new FileNotFoundError(file)
    const name = ctx.request.query('download')
    return new Response(Bun.file(disk.path(file)), {
      headers: {
        'cache-control': 'private, no-store',
        ...(name ? { 'content-disposition': `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"` } : {}),
      },
    })
  }
}
