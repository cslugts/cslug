import { AppError, CslugError, type Duration, parseSize, sniffType } from '@cslug/core'

/** What `put()` accepts. */
export type Body = string | Uint8Array | ArrayBuffer | Blob
export type PutOptions = { type?: string }
/** `download` sends the file as an attachment with this name. */
export type SignedUrlOptions = { expiresIn: Duration; download?: string }
export type UploadUrlOptions = { expiresIn: Duration; type: string; maxSize?: string | number }
/** Where and how the browser sends the file: `fetch(url, { method, headers, body: file })`. */
export type UploadUrl = { url: string; method: 'PUT'; headers: Record<string, string> }
export type FileInfo = { size: number; type: string }
export type UploadRules = { maxSize?: string | number; types?: readonly string[] }

/** A key that does not exist on the disk. */
export class FileNotFoundError extends AppError {
  constructor(readonly key: string) {
    super('storage.not_found', 'File not found', { status: 404 })
  }
}

/** A direct upload that `verifyUpload()` refused (it is deleted). */
export class UploadRejectedError extends AppError {
  constructor(reason: 'too_large' | 'type') {
    super(`storage.upload_${reason}`, reason === 'type' ? 'File type not allowed' : 'File too large', { status: 422 })
  }
}

/** Keys are relative paths: no leading `/`, no `.` or `..` segments, no backslashes. */
export function checkKey(key: string): string {
  if (!key || /^\/|\\|\0/.test(key) || key.split('/').some((s) => s === '' || s === '.' || s === '..'))
    throw new CslugError('storage.bad_key', `Invalid storage key "${key}"`)
  return key
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}

/** The extension for a type, else the file name's (letters and digits only), else none. */
export function extensionFor(type: string, name?: string): string {
  const known = EXTENSIONS[type.split(';')[0]?.trim() ?? '']
  if (known) return known
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(name ?? '')?.[1]
  return fromName ? fromName.toLowerCase() : ''
}

/**
 * One storage location. Drivers provide `file()` (a Blob over the stored bytes), `put`, `exists`, `delete`, and
 * signed URLs; reading, `putFile` and `verifyUpload` are shared.
 */
export abstract class Disk {
  constructor(readonly name: string) {}

  protected abstract file(key: string): Blob
  abstract put(key: string, data: Body, options?: PutOptions): Promise<void>
  abstract exists(key: string): Promise<boolean>
  /** Deleting a missing key is not an error. */
  abstract delete(key: string): Promise<void>
  /** A private download link. */
  abstract signedUrl(key: string, options: SignedUrlOptions): Promise<string>
  /** A link the browser uploads to directly; call `verifyUpload()` once it reports the upload done. */
  abstract signedUploadUrl(key: string, options: UploadUrlOptions): Promise<UploadUrl>

  async stat(key: string): Promise<FileInfo> {
    if (!(await this.exists(key))) throw new FileNotFoundError(key)
    const f = this.file(key)
    return { size: f.size, type: f.type }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await this.file(key).arrayBuffer())
    } catch (error) {
      if (!(await this.exists(key))) throw new FileNotFoundError(key)
      throw error
    }
  }

  async text(key: string): Promise<string> {
    return new TextDecoder().decode(await this.get(key))
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    if (!(await this.exists(key))) throw new FileNotFoundError(key)
    return this.file(key).stream()
  }

  /** Store an upload under a generated name, `dir/<uuidv7>.<ext>` (type sniffed from the bytes); returns the key. */
  async putFile(dir: string, file: Blob): Promise<string> {
    const type = (await sniffType(file)) ?? file.type
    const ext = extensionFor(type, (file as Partial<File>).name)
    const key = checkKey(`${dir.replace(/\/+$/, '')}/${Bun.randomUUIDv7()}${ext ? `.${ext}` : ''}`)
    await this.put(key, file, type ? { type } : {})
    return key
  }

  /** After a direct upload: check size and type (from the bytes when recognisable); a refused file is deleted. */
  async verifyUpload(key: string, rules: UploadRules): Promise<FileInfo> {
    const info = await this.stat(key)
    let reason: 'too_large' | 'type' | undefined
    if (rules.maxSize !== undefined && info.size > parseSize(rules.maxSize)) reason = 'too_large'
    else if (rules.types) {
      const type = (await sniffType(this.file(key))) ?? info.type.split(';')[0] ?? ''
      if (!rules.types.includes(type)) reason = 'type'
      else info.type = type
    }
    if (!reason) return info
    await this.delete(key)
    throw new UploadRejectedError(reason)
  }
}
