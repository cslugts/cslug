import { parseDuration } from '@cslug/core'
import { RedisClient } from 'bun'

export type RedisConnectionConfig = {
  url: string
  prefix?: string
  /** How long `ping()` (boot, `/health/ready`) waits for an answer. Default `'5s'`. */
  connectTimeout?: string | number
}
export type RedisConfig = {
  connections?: Record<string, RedisConnectionConfig>
  /** Prefix for every key cslug writes (default: none). */
  prefix?: string
}

type Reply = unknown

/**
 * A Redis connection (`Bun.redis`, RESP3) with a key prefix and a Lua helper. One per named connection;
 * blocking readers (queue workers) take their own with `dedicated()`.
 */
export class Redis {
  readonly client: RedisClient
  private readonly shas = new Map<string, string>()

  constructor(
    readonly url: string,
    readonly prefix = '',
    readonly options: { autoReconnect?: boolean; connectTimeout?: string | number } = {},
    client?: RedisClient,
  ) {
    this.client =
      client ?? new RedisClient(url, { autoReconnect: options.autoReconnect ?? true, enableOfflineQueue: true })
  }

  /** The same connection with a longer prefix (`cache.prefix`). */
  withPrefix(extra: string): Redis {
    return extra ? new Redis(this.url, this.prefix + extra, this.options, this.client) : this
  }

  /** The key with the prefix. */
  key(key: string): string {
    return this.prefix + key
  }

  send(command: string, args: (string | number)[] = []): Promise<Reply> {
    return this.client.send(command, args.map(String))
  }

  /**
   * Run a Lua script: `EVALSHA`, loading it on first use and again after `NOSCRIPT` (a restarted Redis).
   * Keys are prefixed here.
   */
  async eval(script: string, keys: string[], args: (string | number)[] = []): Promise<Reply> {
    let sha = this.shas.get(script)
    if (!sha) {
      sha = (await this.send('SCRIPT', ['LOAD', script])) as string
      this.shas.set(script, sha)
    }
    const call = () => this.send('EVALSHA', [sha as string, keys.length, ...keys.map((k) => this.key(k)), ...args])
    try {
      return await call()
    } catch (error) {
      if (!String(error).includes('NOSCRIPT')) throw error
      this.shas.delete(script)
      return this.eval(script, keys, args)
    }
  }

  /** Fails after `connectTimeout` instead of waiting for a server that is not there (commands queue offline). */
  async ping(): Promise<void> {
    const timeout = parseDuration(this.options.connectTimeout ?? '5s')
    const reply = await Promise.race([
      this.send('PING'),
      Bun.sleep(timeout).then(() => {
        throw new Error(`Redis at ${new URL(this.url).host} did not answer within ${timeout} ms`)
      }),
    ])
    if (reply !== 'PONG') throw new Error(`Redis PING answered ${String(reply)}`)
  }

  /**
   * A new connection to the same server for a blocking loop (queue workers): never shared with other commands,
   * and `autoReconnect: false`, so a dropped connection fails at once instead of hanging (spike c). The caller
   * reconnects by asking for another.
   */
  dedicated(): Redis {
    return new Redis(this.url, this.prefix, { ...this.options, autoReconnect: false })
  }

  /** Every key under the prefix matching `pattern` (SCAN, never KEYS). */
  async *scan(pattern: string): AsyncGenerator<string> {
    let cursor = '0'
    do {
      const [next, keys] = (await this.send('SCAN', [cursor, 'MATCH', this.key(pattern), 'COUNT', 500])) as [
        string,
        string[],
      ]
      cursor = next
      for (const k of keys) yield k
    } while (cursor !== '0')
  }

  close(): void {
    this.client.close()
  }
}

/** JSON with bigint and Date kept (as the memory drivers keep them through structuredClone). */
export const encode = (value: unknown): string =>
  JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    const raw = this[key]
    if (typeof raw === 'bigint') return { $bigint: raw.toString() }
    if (raw instanceof Date) return { $date: raw.toISOString() }
    return v
  })

/** Reverse of `encode()`: restores bigint and Date values; undefined for a missing key. */
export const decode = <T>(text: string | null | undefined): T | undefined =>
  text === null || text === undefined
    ? undefined
    : (JSON.parse(text, (_k, v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const keys = Object.keys(v)
          if (keys.length === 1 && keys[0] === '$bigint') return BigInt(v.$bigint)
          if (keys.length === 1 && keys[0] === '$date') return new Date(v.$date)
        }
        return v
      }) as T)
