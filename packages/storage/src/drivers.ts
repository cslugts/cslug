import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CslugError, parseDuration, parseSize } from '@cslug/core'
import { S3Client, type S3Options } from 'bun'
import {
  type Body,
  checkKey,
  Disk,
  type FileInfo,
  FileNotFoundError,
  type PutOptions,
  type SignedUrlOptions,
  type UploadUrl,
  type UploadUrlOptions,
} from './disk'

const seconds = (options: { expiresIn: SignedUrlOptions['expiresIn'] }) =>
  Math.max(1, Math.round(parseDuration(options.expiresIn) / 1000))
const attachment = (name: string) => `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"`

/** Signs local-disk URLs; set by `StorageProvider` when @cslug/http is installed (served at `/_storage/:disk`). */
export type LocalSigner = (
  query: Record<string, string>,
  options: { expiresIn: SignedUrlOptions['expiresIn'] },
) => string

/** Files under a directory (`root`). Signed URLs are served by the app itself. */
export class LocalDisk extends Disk {
  signer?: LocalSigner

  constructor(
    name: string,
    readonly root: string,
  ) {
    super(name)
  }

  path(key: string): string {
    return join(this.root, checkKey(key))
  }
  protected file(key: string) {
    return Bun.file(this.path(key))
  }
  async put(key: string, data: Body): Promise<void> {
    await Bun.write(this.path(key), data, { createPath: true })
  }
  exists(key: string): Promise<boolean> {
    return this.file(key).exists()
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true })
  }
  private sign(query: Record<string, string>, options: { expiresIn: SignedUrlOptions['expiresIn'] }): string {
    if (!this.signer)
      throw new CslugError('storage.no_http', `Signed URLs on the local disk "${this.name}" need @cslug/http`)
    return this.signer({ disk: this.name, ...query }, options)
  }
  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return this.sign({ key: checkKey(key), ...(options.download ? { download: options.download } : {}) }, options)
  }
  async signedUploadUrl(key: string, options: UploadUrlOptions): Promise<UploadUrl> {
    const query: Record<string, string> = { key: checkKey(key), upload: options.type }
    if (options.maxSize !== undefined) query.max = String(parseSize(options.maxSize))
    return { url: this.sign(query, options), method: 'PUT', headers: { 'content-type': options.type } }
  }
}

/** `config/storage.ts` → `{ driver: 's3', bucket, endpoint?, region?, accessKeyId?, secretAccessKey? }` (credentials default to the S3_* env). */
export type S3DiskConfig = { driver: 's3' } & S3Options

/** Any S3-compatible service, through `Bun.s3`. Signed URLs are presigned by the service's credentials. */
export class S3Disk extends Disk {
  readonly client: S3Client

  constructor(name: string, config: S3Options) {
    super(name)
    this.client = new S3Client(config)
  }

  protected file(key: string) {
    return this.client.file(checkKey(key))
  }
  async put(key: string, data: Body, options: PutOptions = {}): Promise<void> {
    await this.client.write(checkKey(key), data, options.type ? { type: options.type } : {})
  }
  exists(key: string): Promise<boolean> {
    return this.client.exists(checkKey(key))
  }
  async delete(key: string): Promise<void> {
    await this.client.delete(checkKey(key))
  }
  override async stat(key: string): Promise<FileInfo> {
    try {
      const s = await this.client.stat(checkKey(key))
      return { size: s.size, type: s.type }
    } catch (error) {
      if ((error as { code?: string }).code === 'NoSuchKey' || !(await this.exists(key)))
        throw new FileNotFoundError(key)
      throw error
    }
  }
  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return this.client.presign(checkKey(key), {
      method: 'GET',
      expiresIn: seconds(options),
      ...(options.download ? { contentDisposition: attachment(options.download) } : {}),
    })
  }
  /** Presigned PUT: the type is part of the signature; the size is checked afterwards by `verifyUpload()`. */
  async signedUploadUrl(key: string, options: UploadUrlOptions): Promise<UploadUrl> {
    const url = this.client.presign(checkKey(key), { method: 'PUT', expiresIn: seconds(options), type: options.type })
    return { url, method: 'PUT', headers: { 'content-type': options.type } }
  }
}

/** Files in memory: the `memory` driver and the test fake. Signed URLs are `memory://` placeholders. */
export class MemoryDisk extends Disk {
  readonly files = new Map<string, Blob>()

  protected file(key: string): Blob {
    const blob = this.files.get(checkKey(key))
    if (!blob) throw new FileNotFoundError(key)
    return blob
  }
  async put(key: string, data: Body, options: PutOptions = {}): Promise<void> {
    // a copy: later changes to the caller's buffer must not change the stored file
    const bytes =
      data instanceof Blob ? await data.arrayBuffer() : typeof data === 'string' ? data : new Uint8Array(data)
    const type = options.type ?? (data instanceof Blob ? data.type : '')
    this.files.set(checkKey(key), new Blob([bytes], { type }))
  }
  async exists(key: string): Promise<boolean> {
    return this.files.has(checkKey(key))
  }
  async delete(key: string): Promise<void> {
    this.files.delete(checkKey(key))
  }
  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return `memory://${this.name}/${checkKey(key)}?expires=${seconds(options)}`
  }
  async signedUploadUrl(key: string, options: UploadUrlOptions): Promise<UploadUrl> {
    return {
      url: `memory://${this.name}/${checkKey(key)}?upload=1&expires=${seconds(options)}`,
      method: 'PUT',
      headers: { 'content-type': options.type },
    }
  }
}
