import { randomBytes } from 'node:crypto'
import { type Clock, ConflictError } from '@cslug/core'
import { type Database, decrypt, encrypt, sql } from '@cslug/database'
import { idOf } from './config'
import { base32Encode, otpauthUri, totpSecret, verifyTotp } from './totp'

/** `config/auth.ts` → `twoFactor`. */
export type TwoFactorConfig = {
  /** The name authenticator apps show (default `app.name`). */
  issuer?: string
  /** Time steps of drift accepted on each side (default 1: ±30 s). */
  window?: number
  /** How many recovery codes are made (default 8). */
  recoveryCodes?: number
  /** How long a password login waits for its code (default 10 minutes, in ms or a duration such as `'10m'`). */
  challengeLifetime?: string | number
}

type Row = { secret: string; confirmedAt: Date | null; lastCounter: string | number }
const hashCode = (code: string) =>
  new Bun.CryptoHasher('sha256').update(code.toLowerCase().replace(/[\s-]/g, '')).digest('hex')
const recoveryCode = () => {
  const raw = base32Encode(randomBytes(10)).toLowerCase() // 16 characters
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`
}

/**
 * TOTP two-factor authentication (RFC 6238, the codes of Google Authenticator, 1Password, Authy…), stored in
 * `cslug_two_factor`: `enable` gives a secret to scan, `confirm` checks a first code and turns it on (with recovery
 * codes), `verify` checks a code at login. A code is accepted once; a recovery code once.
 */
export class TwoFactor {
  constructor(
    private readonly db: () => Database,
    private readonly clock: () => Clock,
    private readonly config: TwoFactorConfig & { issuer: string },
  ) {}

  private async row(user: object | string): Promise<Row | null> {
    const id = typeof user === 'string' ? user : idOf(user)
    return this.db().maybeOne<Row>(
      sql`select secret, confirmed_at, last_counter from cslug_two_factor where user_id = ${id}`,
    )
  }

  /** True once the user confirmed a code (logins then ask for one). */
  async enabled(user: object | string): Promise<boolean> {
    return !!(await this.row(user))?.confirmedAt
  }

  /**
   * Start (or restart) enrolment: a new secret, not active until `confirm`. Show `uri` as a QR code (or `secret` to
   * type in). A user who already has 2FA must `disable` it first (`ConflictError`).
   */
  async enable(user: object, account: string): Promise<{ secret: string; uri: string }> {
    if (await this.enabled(user))
      throw new ConflictError('auth.two_factor_enabled', {}, 'Two-factor authentication is already on')
    const secret = totpSecret()
    await this.db().exec(sql`insert into cslug_two_factor (user_id, secret) values (${idOf(user)}, ${encrypt(secret)})
      on conflict (user_id) do update set secret = excluded.secret, confirmed_at = null, recovery_codes = '[]',
        last_counter = 0`)
    return { secret, uri: otpauthUri(secret, account, this.config.issuer) }
  }

  /** Turn 2FA on with a first code from the app; returns the recovery codes (show them once), or null for a bad code. */
  async confirm(user: object, code: string): Promise<string[] | null> {
    const row = await this.row(user)
    if (!row || row.confirmedAt) return null
    if (!(await this.accept(idOf(user), row, code))) return null
    const codes = this.newCodes()
    await this.db().exec(sql`update cslug_two_factor set confirmed_at = ${this.clock().now()},
      recovery_codes = ${sql.json(codes.map(hashCode))} where user_id = ${idOf(user)}`)
    return codes
  }

  /** A code from the app, or a recovery code (used up). False for anything else, or when 2FA is off. */
  async verify(user: object | string, code: string): Promise<boolean> {
    const id = typeof user === 'string' ? user : idOf(user)
    const row = await this.row(id)
    if (!row?.confirmedAt) return false
    if (/^\s*\d[\d\s]*$/.test(code)) return this.accept(id, row, code)
    const used = await this.db().exec(sql`update cslug_two_factor
      set recovery_codes = recovery_codes - ${hashCode(code)}::text
      where user_id = ${id} and recovery_codes ? ${hashCode(code)}::text`)
    return used === 1
  }

  /** New recovery codes (the old ones stop working); null when 2FA is off. */
  async regenerateRecoveryCodes(user: object): Promise<string[] | null> {
    const codes = this.newCodes()
    const n = await this.db().exec(sql`update cslug_two_factor set recovery_codes = ${sql.json(codes.map(hashCode))}
      where user_id = ${idOf(user)} and confirmed_at is not null`)
    return n ? codes : null
  }

  /** How many recovery codes are left. */
  async remainingRecoveryCodes(user: object): Promise<number> {
    return Number(
      (await this.db().value(
        sql`select jsonb_array_length(recovery_codes) from cslug_two_factor where user_id = ${idOf(user)}`,
      )) ?? 0,
    )
  }

  /** Turn 2FA off (the secret and recovery codes are deleted). */
  async disable(user: object): Promise<void> {
    await this.db().exec(sql`delete from cslug_two_factor where user_id = ${idOf(user)}`)
  }

  private newCodes() {
    return Array.from({ length: this.config.recoveryCodes ?? 8 }, recoveryCode)
  }

  /** The code's time step, if valid and later than the last one accepted (atomically: no replay). */
  private async accept(id: string, row: Row, code: string): Promise<boolean> {
    const step = verifyTotp(decrypt(row.secret), code, this.clock().now(), { window: this.config.window ?? 1 })
    if (step === null) return false
    const n = await this.db().exec(sql`update cslug_two_factor set last_counter = ${step}
      where user_id = ${id} and last_counter < ${step}`)
    return n === 1
  }
}
