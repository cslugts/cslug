# @cslug/storage

List `StorageProvider` in `bootstrap/providers.ts` and inject `Storage`. The guide is
[guide 17](../../../guides/17-storage-and-webhooks.md#storage).

## Disks

```ts
// config/storage.ts
export default defineConfig({
  default: env.APP_ENV === 'production' ? 's3' : 'local',
  disks: {
    local: { driver: 'local', root: 'storage/app' },               // relative to the app root
    s3: { driver: 's3', bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT, region: 'eu-west-3' },
  },
})
```

Without `config/storage.ts` there is one `local` disk at `storage/app`. `Storage` methods use the default disk;
`storage.disk('s3')` returns another. Drivers:

- `local`: files under `root` (`Bun.file`, `Bun.write`).
- `s3`: any S3-compatible service through `Bun.s3`. The options are `Bun.S3Options`; credentials default to the
  `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` environment variables.
- `memory`: in the process (tests, throwaway data).

Keys are relative paths (`operators/7/licence/…pdf`); a leading `/`, `.` or `..` segments and backslashes are
refused (`storage.bad_key`), so a key can never leave the disk.

## Writing and reading

- `put(key, data, { type? })`: a string, bytes or a `Blob`.
- `putFile(dir, file)`: for uploads. The key is generated, `dir/<uuidv7>.<ext>`, never the client's file name; the
  extension comes from the type sniffed from the first bytes (PDF, PNG, JPEG, GIF, WebP), else the declared type,
  else the name's extension. Validate the upload first with `v.file({ maxSize, types })`, which checks the bytes too.
- `get(key)` (bytes), `text(key)`, `stream(key)`, `stat(key)` (`{ size, type }`), `exists(key)`, `delete(key)`
  (a missing key is fine). A missing key throws `FileNotFoundError` (404 when it reaches a response).

## Signed URLs

`signedUrl(key, { expiresIn, download? })` is a private download link; `download: 'Licence.pdf'` sends it as an
attachment with that name. On S3 it is presigned by the service. On a local disk the app serves it: with
`@cslug/http` installed, `StorageProvider` adds `GET /_storage/:disk` (route `storage.file`), outside the web and
api groups, which checks the signature (`APP_KEY`) and expiry and streams the file with `Cache-Control: private,
no-store`. Without `@cslug/http`, a local signed URL throws `storage.no_http`.

## Direct uploads

`signedUploadUrl(key, { expiresIn, type, maxSize? })` returns `{ url, method: 'PUT', headers }` for the browser:
`fetch(url, { method, headers, body: file })`. The content type is part of the signature. When the browser reports
the upload done, call `verifyUpload(key, { maxSize?, types? })`: it checks the stored size and the type sniffed from
the bytes, returns `{ size, type }`, and deletes the file and throws `UploadRejectedError` (422,
`storage.upload_too_large` / `storage.upload_type`) when it does not pass.

Why the second step: an S3 presigned PUT cannot limit the size, so the size is checked after the upload. On a local
disk the `PUT /_storage/:disk` route also refuses another content type (415) and a body over `maxSize` (413), and it
is subject to `http.bodyLimit`.

## Tests

`testApp({ fakes: ['storage'] })` replaces every configured disk with a memory disk: `t.storage` is a
`StorageFake` with `assertExists(key, disk?)`, `assertMissing(key, disk?)` (a key ending in `/` matches any file
under it, for generated names) and `keys(disk?)`.
