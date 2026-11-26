import type { Application } from '@cslug/core'
import { MemoryDisk } from './drivers'
import { DEFAULT_DISKS, Storage, type StorageConfig } from './storage'

/** Every configured disk replaced by one in memory (`fakes: ['storage']` → `t.storage`). */
export class StorageFake extends Storage {
  constructor(names: string[], defaultDisk: string) {
    super(new Map(names.map((n) => [n, new MemoryDisk(n)])), defaultDisk)
  }

  /** Keys on a disk (the default one unless named). */
  keys(disk?: string): string[] {
    return [...(this.disk(disk) as MemoryDisk).files.keys()]
  }

  /** A file exists at `key`, or under it when `key` ends with `/` (generated names: `putFile`). */
  assertExists(key: string, disk?: string): void {
    if (!this.keys(disk).some((k) => (key.endsWith('/') ? k.startsWith(key) : k === key)))
      throw new Error(`Expected a file at "${key}"; stored: ${this.keys(disk).join(', ') || 'none'}`)
  }

  assertMissing(key: string, disk?: string): void {
    const found = this.keys(disk).filter((k) => (key.endsWith('/') ? k.startsWith(key) : k === key))
    if (found.length) throw new Error(`Expected no file at "${key}"; found ${found.join(', ')}`)
  }
}

export function installStorageFake(app: Application): StorageFake {
  const config = app.config<StorageConfig | undefined>('storage') ?? {}
  const names = Object.keys(config.disks ?? DEFAULT_DISKS)
  const fake = new StorageFake(names, config.default ?? names[0] ?? 'local')
  app.swap(Storage, fake)
  return fake
}
