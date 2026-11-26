# @cslug/storage

Disks for uploaded and generated files: local, any S3-compatible service (through `Bun.s3`), and memory.
Generated keys with the type sniffed from the bytes, signed download and direct-upload URLs, and a fake for tests.
List `StorageProvider` in `bootstrap/providers.ts`.

Part of [cslug](https://github.com/cslugts/cslug). Docs: [docs/README.md](docs/README.md), [docs/api.md](docs/api.md),
[guide 17](../../guides/17-storage-and-webhooks.md).
