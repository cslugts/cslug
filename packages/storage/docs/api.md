# @cslug/storage: API

| | |
|---|---|
| `Storage` | Injectable. The default disk's methods, `disk(name?)`, `names()`, `defaultDisk` |
| `Disk` | `put(key, data, { type? })`, `putFile(dir, file)` → key, `get`, `text`, `stream`, `stat` → `{ size, type }`, `exists`, `delete`, `signedUrl(key, { expiresIn, download? })`, `signedUploadUrl(key, { expiresIn, type, maxSize? })` → `{ url, method, headers }`, `verifyUpload(key, { maxSize?, types? })` → `{ size, type }` |
| `LocalDisk(name, root)` | `path(key)`; signed URLs through `StorageProvider` and @cslug/http |
| `S3Disk(name, options)` | `Bun.S3Options`; `client` is the `S3Client` |
| `MemoryDisk(name)` | `files`: the stored `Blob`s by key |
| `StorageProvider` | Config `storage`: `default`, `disks.<name>` (`{ driver: 'local', root }`, `{ driver: 's3', …S3Options }`, `{ driver: 'memory' }`). With @cslug/http: `GET`/`PUT /_storage/:disk` (route `storage.file`) |
| `createDisk(name, config, rootDir)` | A disk from its config |
| `checkKey(key)` | The key, or `storage.bad_key` |
| `extensionFor(type, name?)` | Extension for a type, else the name's |
| `FileNotFoundError` | 404 `storage.not_found`; `key` |
| `UploadRejectedError` | 422 `storage.upload_too_large` / `storage.upload_type` |
| `StorageFake`, `installStorageFake(app)` | `fakes: ['storage']`: memory disks, `assertExists`, `assertMissing`, `keys` |
