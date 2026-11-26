import { isAbsolute, join } from 'node:path'
import { CslugError } from '@cslug/core'
import type { Body, Disk, PutOptions, SignedUrlOptions, UploadRules, UploadUrlOptions } from './disk'
import { LocalDisk, MemoryDisk, S3Disk, type S3DiskConfig } from './drivers'

export type DiskConfig = { driver: 'local'; root: string } | S3DiskConfig | { driver: 'memory' }

/** `config/storage.ts`. Without it: one `local` disk at `storage/app`. */
export type StorageConfig = { default?: string; disks?: Record<string, DiskConfig> }

export const DEFAULT_DISKS: Record<string, DiskConfig> = { local: { driver: 'local', root: 'storage/app' } }

/** Build a disk from its config; a relative local root is resolved against the app root. */
export function createDisk(name: string, config: DiskConfig, rootDir: string): Disk {
  switch (config.driver) {
    case 'local':
      return new LocalDisk(name, isAbsolute(config.root) ? config.root : join(rootDir, config.root))
    case 's3': {
      const { driver: _, ...options } = config
      return new S3Disk(name, options)
    }
    case 'memory':
      return new MemoryDisk(name)
    default:
      throw new CslugError(
        'storage.unknown_driver',
        `Unknown storage driver "${(config as { driver: string }).driver}" (local, s3, memory)`,
      )
  }
}

/**
 * The configured disks, injected as `Storage`. Its methods use the default disk; `disk(name)` picks another.
 * Uploaded files never live under `public/`: they are read back through the app or a signed URL.
 */
export class Storage {
  constructor(
    private readonly disks: ReadonlyMap<string, Disk>,
    readonly defaultDisk: string,
  ) {
    if (!disks.has(defaultDisk)) throw new CslugError('storage.unknown_disk', `No disk "${defaultDisk}" configured`)
  }

  disk(name = this.defaultDisk): Disk {
    const disk = this.disks.get(name)
    if (!disk) throw new CslugError('storage.unknown_disk', `No disk "${name}" (config storage.disks)`)
    return disk
  }
  names(): string[] {
    return [...this.disks.keys()]
  }

  put(key: string, data: Body, options?: PutOptions) {
    return this.disk().put(key, data, options)
  }
  putFile(dir: string, file: Blob) {
    return this.disk().putFile(dir, file)
  }
  get(key: string) {
    return this.disk().get(key)
  }
  text(key: string) {
    return this.disk().text(key)
  }
  stream(key: string) {
    return this.disk().stream(key)
  }
  exists(key: string) {
    return this.disk().exists(key)
  }
  stat(key: string) {
    return this.disk().stat(key)
  }
  delete(key: string) {
    return this.disk().delete(key)
  }
  signedUrl(key: string, options: SignedUrlOptions) {
    return this.disk().signedUrl(key, options)
  }
  signedUploadUrl(key: string, options: UploadUrlOptions) {
    return this.disk().signedUploadUrl(key, options)
  }
  verifyUpload(key: string, rules: UploadRules) {
    return this.disk().verifyUpload(key, rules)
  }
}
