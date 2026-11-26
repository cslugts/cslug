import type { AuthConfig } from './config'

type Options = NonNullable<AuthConfig['passwords']>

/** Password hashing through `Bun.password` (argon2id by default). */
export class Hash {
  constructor(private readonly options: Options = {}) {}

  private params(): Parameters<typeof Bun.password.hash>[1] {
    const algorithm = this.options.algorithm ?? 'argon2id'
    if (algorithm === 'bcrypt') return { algorithm, cost: this.options.cost ?? 10 }
    return { algorithm, memoryCost: this.options.memoryCost ?? 65536, timeCost: this.options.timeCost ?? 2 }
  }

  make(plain: string): Promise<string> {
    return Bun.password.hash(plain, this.params())
  }

  /** Constant-time; false for a malformed hash instead of throwing. */
  async verify(plain: string, hash: string | null | undefined): Promise<boolean> {
    if (!hash) return false
    try {
      return await Bun.password.verify(plain, hash)
    } catch {
      return false
    }
  }

  /** True when the hash was made with other parameters (verify, then store `make()` again). */
  needsRehash(hash: string): boolean {
    const p = this.params() as { algorithm: string; memoryCost?: number; timeCost?: number; cost?: number }
    if (p.algorithm === 'bcrypt') return !hash.startsWith('$2') || Number(hash.split('$')[2]) !== p.cost
    const m = /^\$(argon2id|argon2i|argon2d)\$v=\d+\$m=(\d+),t=(\d+)/.exec(hash)
    return !m || m[1] !== p.algorithm || Number(m[2]) !== p.memoryCost || Number(m[3]) !== p.timeCost
  }
}
