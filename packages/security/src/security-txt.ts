import { CslugError } from '@cslug/core'

export type SecurityTxtOptions = {
  /** Where to report a vulnerability: `mailto:` or `https:` URLs (required). */
  contact: string | string[]
  /** When the file is stale (default: a year after the process started). */
  expires?: Date | string
  encryption?: string | string[]
  acknowledgments?: string | string[]
  /** Languages reports may be written in (`['en', 'fr']`). */
  preferredLanguages?: string | string[]
  policy?: string | string[]
  hiring?: string | string[]
  /** Default: `<app.url>/.well-known/security.txt`. */
  canonical?: string | string[]
}

const list = (value: string | string[] | undefined) => (value === undefined ? [] : [value].flat())

/** The body of `/.well-known/security.txt` (RFC 9116). */
export function securityTxt(options: SecurityTxtOptions, defaults: { expires: Date; canonical?: string }): string {
  const contacts = list(options.contact)
  if (!contacts.length)
    throw new CslugError('security.txt_contact', 'security.securityTxt needs a contact (mailto: or https: URL)')
  const expires = options.expires === undefined ? defaults.expires : new Date(options.expires)
  if (Number.isNaN(expires.getTime()))
    throw new CslugError('security.txt_expires', `security.securityTxt.expires is not a date: ${options.expires}`)
  const lines = [
    ...contacts.map((c) => `Contact: ${c}`),
    `Expires: ${expires.toISOString()}`,
    ...list(options.encryption).map((v) => `Encryption: ${v}`),
    ...list(options.acknowledgments).map((v) => `Acknowledgments: ${v}`),
    ...(options.preferredLanguages ? [`Preferred-Languages: ${list(options.preferredLanguages).join(', ')}`] : []),
    ...list(options.policy).map((v) => `Policy: ${v}`),
    ...list(options.hiring).map((v) => `Hiring: ${v}`),
    ...list(options.canonical ?? defaults.canonical).map((v) => `Canonical: ${v}`),
  ]
  return `${lines.join('\n')}\n`
}
