/**
 * @cslug/storage: disks (local, S3 through `Bun.s3`, memory), generated keys with the type sniffed from the bytes,
 * signed download and upload URLs, and a fake for tests.
 */
export {
  type Body,
  checkKey,
  Disk,
  extensionFor,
  type FileInfo,
  FileNotFoundError,
  type PutOptions,
  type SignedUrlOptions,
  UploadRejectedError,
  type UploadRules,
  type UploadUrl,
  type UploadUrlOptions,
} from './disk'
export { LocalDisk, type LocalSigner, MemoryDisk, S3Disk, type S3DiskConfig } from './drivers'
export { installStorageFake, StorageFake } from './fake'
export { StorageProvider } from './provider'
export { createDisk, type DiskConfig, Storage, type StorageConfig } from './storage'
