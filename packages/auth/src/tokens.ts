import { createHash, timingSafeEqual } from 'node:crypto'
import { type AuthUser, Clock, inject, parseDuration } from '@cslug/core'
import { Database, sql } from '@cslug/database'
import { idOf } from './config'
import { TokenCreated, TokenRevoked } from './events'

export type AccessToken = {
  id: string
  userId: string
  name: string
  abilities: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

/**
 * Opaque API tokens: `<id>.<secret>`, only the SHA-256 of the secret is stored (`cslug_access_tokens`).
 * Scoped by abilities (`['quotes:write']`, `'*'` for all) and optionally expiring.
 */
@inject(Database, Clock)
export class Tokens {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** The plain text is returned once; show it to the user then, it cannot be recovered. */
  async create(
    user: AuthUser,
    options: { name: string; abilities?: string[]; expiresIn?: string | number },
  ): Promise<{ plainText: string; token: AccessToken }> {
    const id = Bun.randomUUIDv7()
    const plain = secret()
    const expires =
      options.expiresIn === undefined ? null : new Date(this.clock.now().getTime() + parseDuration(options.expiresIn))
    const row =
      await this.db.one<AccessToken>(sql`insert into cslug_access_tokens (id, user_id, name, token_hash, abilities, expires_at)
      values (${id}, ${idOf(user)}, ${options.name}, ${sha256(plain)}, ${sql.json(options.abilities ?? ['*'])}, ${expires}) returning *`)
    await TokenCreated.emit({
      userId: idOf(user),
      tokenId: id,
      name: options.name,
      abilities: options.abilities ?? ['*'],
    })
    return { plainText: `${id}.${plain}`, token: clean(row) }
  }

  /** The token for a plain text, if valid and not expired (and marks it used, at most once a minute). */
  async verify(plainText: string): Promise<AccessToken | null> {
    const [id, plain] = plainText.split('.')
    if (!id || !plain || !/^[0-9a-f-]{36}$/.test(id)) return null
    const row = await this.db.maybeOne<AccessToken & { tokenHash: string }>(
      sql`select * from cslug_access_tokens where id = ${id}`,
    )
    if (!row) return null
    const a = Buffer.from(sha256(plain))
    const b = Buffer.from(row.tokenHash)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const now = this.clock.now()
    if (row.expiresAt && row.expiresAt <= now) return null
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > 60_000) {
      await this.db.exec(sql`update cslug_access_tokens set last_used_at = ${now} where id = ${id}`)
    }
    return clean(row)
  }

  list(user: AuthUser): Promise<AccessToken[]> {
    return this.db
      .many<AccessToken>(sql`select * from cslug_access_tokens where user_id = ${idOf(user)} order by created_at desc`)
      .then((rows) => rows.map(clean))
  }

  async revoke(id: string): Promise<void> {
    if (await this.db.exec(sql`delete from cslug_access_tokens where id = ${id}`))
      await TokenRevoked.emit({ tokenId: id })
  }

  async revokeAll(user: AuthUser): Promise<void> {
    await this.db.exec(sql`delete from cslug_access_tokens where user_id = ${idOf(user)}`)
    await TokenRevoked.emit({ userId: idOf(user), all: true })
  }
}

const clean = (row: AccessToken & { tokenHash?: string }): AccessToken => {
  const { tokenHash: _hash, ...rest } = row
  return rest
}

/** Does a token allow an ability? `*` allows everything; `quotes:*` allows `quotes:write`. */
export const tokenCan = (token: AccessToken, ability: string): boolean =>
  token.abilities.some((a) => a === '*' || a === ability || (a.endsWith(':*') && ability.startsWith(a.slice(0, -1))))
