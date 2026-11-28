import { createHash } from 'node:crypto'
import { currentApp, type Duration, Logger, parseDuration } from '@cslug/core'

type Range = (prefix: string, signal: AbortSignal) => Promise<string>

const hibp: Range = async (prefix, signal) => {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'add-padding': 'true', 'user-agent': 'cslug' },
    signal,
  })
  if (!res.ok) throw new Error(`HaveIBeenPwned answered ${res.status}`)
  return res.text()
}

const sha1 = (password: string) => createHash('sha1').update(password).digest('hex').toUpperCase()

const warn = (message: string, fields: Record<string, unknown>) => {
  try {
    currentApp().resolve(Logger).warn(message, fields)
  } catch {
    console.warn(message, fields)
  }
}

/**
 * Passwords seen in public breaches, through HaveIBeenPwned's range API (k-anonymity: only the first 5 characters of
 * the password's SHA-1 leave the server, and the answer is padded).
 */
// biome-ignore lint/complexity/noStaticOnlyClass: the name guide 24 documents (`BreachedPasswords.fake()`)
export class BreachedPasswords {
  private static range: Range = hibp

  /** How many times the password appears in breaches (0: never), or undefined when the API could not answer. */
  static async count(password: string, options: { timeout?: Duration } = {}): Promise<number | undefined> {
    const hash = sha1(password)
    try {
      const body = await BreachedPasswords.range(
        hash.slice(0, 5),
        AbortSignal.timeout(parseDuration(options.timeout ?? '2s')),
      )
      for (const line of body.split('\n')) {
        const [suffix, count] = line.trim().split(':')
        if (suffix?.toUpperCase() === hash.slice(5)) return Number(count) || 0
      }
      return 0
    } catch (error) {
      warn('security.breached_passwords_unavailable', { error: (error as Error).message })
      return undefined
    }
  }

  /** In tests: only `passwords` count as breached, and nothing is sent. Returns a function that restores the API. */
  static fake(passwords: string[] = [], options: { unavailable?: boolean } = {}): () => void {
    const previous = BreachedPasswords.range
    const hashes = passwords.map(sha1)
    BreachedPasswords.range = async (prefix) => {
      if (options.unavailable) throw new Error('unavailable (fake)')
      return hashes
        .filter((h) => h.startsWith(prefix))
        .map((h) => `${h.slice(5)}:1`)
        .join('\r\n')
    }
    return () => {
      BreachedPasswords.range = previous
    }
  }
}

/**
 * A check for `refineAsync`: false when the password appears in at least `threshold` breaches (default 1). Fails
 * open: when the API is down or slow, the password is accepted and a warning is logged.
 *
 * ```ts
 * password: v.string().min(12).refineAsync(notBreached(), { message: 'validation.password_breached' })
 * ```
 */
export function notBreached(
  options: { threshold?: number; timeout?: Duration } = {},
): (password: string) => Promise<boolean> {
  return async (password) => {
    const count = await BreachedPasswords.count(password, options)
    return count === undefined || count < (options.threshold ?? 1)
  }
}
