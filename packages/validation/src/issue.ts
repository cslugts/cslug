/** A problem found while validating, at a path inside the input. `message` is a translation key. */
export type Issue = {
  path: (string | number)[]
  /** Stable machine code, e.g. `string.min`, `required`, `email`. */
  code: string
  /** Translation key, e.g. `validation.string.min`, or a custom key such as `bookings.terms_required`. */
  message: string
  /** Values for the message, e.g. `{ min: 3 }`. */
  params?: Record<string, unknown>
}

/** Translate a message key with params; return undefined to fall back to the built-in English text. */
export type Translate = (key: string, params: Record<string, unknown>) => string | undefined

const english: Record<string, string> = {
  'validation.required': 'This field is required.',
  'validation.invalid_type': 'Must be a {expected}.',
  'validation.string.min': 'Must be at least {min} characters.',
  'validation.string.max': 'Must be at most {max} characters.',
  'validation.string.length': 'Must be exactly {length} characters.',
  'validation.string.regex': 'Has an invalid format.',
  'validation.email': 'Must be a valid email address.',
  'validation.url': 'Must be a valid URL.',
  'validation.uuid': 'Must be a valid UUID.',
  'validation.number.min': 'Must be at least {min}.',
  'validation.number.max': 'Must be at most {max}.',
  'validation.int': 'Must be a whole number.',
  'validation.int.min': 'Must be at least {min}.',
  'validation.int.max': 'Must be at most {max}.',
  'validation.bigint.min': 'Must be at least {min}.',
  'validation.bigint.max': 'Must be at most {max}.',
  'validation.array.min': 'Must contain at least {min} items.',
  'validation.array.max': 'Must contain at most {max} items.',
  'validation.enum': 'Must be one of: {options}.',
  'validation.literal': 'Must be {expected}.',
  'validation.date': 'Must be a valid date (YYYY-MM-DD).',
  'validation.date.future': 'Must be a date in the future.',
  'validation.date.past': 'Must be a date in the past.',
  'validation.date.min': 'Must be on or after {min}.',
  'validation.date.max': 'Must be on or before {max}.',
  'validation.datetime': 'Must be a valid date and time.',
  'validation.unrecognized_keys': 'Unexpected field(s): {keys}.',
  'validation.union': 'Does not match any allowed shape.',
  'validation.currency': 'Must be a supported currency.',
  'validation.money': 'Must be an amount in minor units with a currency.',
  'validation.country': 'Must be a valid country code.',
  'validation.phone': 'Must be a valid phone number.',
  'validation.file': 'Must be a file.',
  'validation.file.size': 'Must be at most {max}.',
  'validation.file.type': 'Must be one of: {types}.',
  'validation.unique': 'This value is already taken.',
  'validation.custom': 'Is invalid.',
}

/** Replace `{name}` placeholders. Arrays are joined with ", ". */
export function interpolate(template: string, params: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    if (value === undefined) return whole
    return Array.isArray(value) ? value.join(', ') : String(value)
  })
}

/** Human-readable text for an issue: the translator first, then the built-in English text, then the key itself. */
export function formatMessage(issue: Pick<Issue, 'message' | 'params'>, translate?: Translate): string {
  const params = issue.params ?? {}
  return translate?.(issue.message, params) ?? interpolate(english[issue.message] ?? issue.message, params)
}

function groupByPath(issues: Issue[], text: (issue: Issue) => string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of issues) {
    const key = issue.path.join('.')
    const list = out[key] ?? []
    list.push(text(issue))
    out[key] = list
  }
  return out
}

const toIssues = (errors: Record<string, string | string[]>): Issue[] =>
  Object.entries(errors).flatMap(([path, keys]) =>
    (Array.isArray(keys) ? keys : [keys]).map((key) => ({
      path: path === '' ? [] : path.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
      code: key.startsWith('validation.') ? key.slice('validation.'.length) : 'custom',
      message: key,
    })),
  )

/**
 * Thrown when input is invalid. HTTP renders it as 422 (problem+json for APIs, redirect back with errors for
 * forms). Construct from issues, or from `{ field: ['message.key'] }` in application code.
 */
export class ValidationError extends Error {
  readonly status = 422
  readonly code = 'validation.failed'
  readonly issues: Issue[]

  constructor(input: Issue[] | Record<string, string | string[]>) {
    const issues = Array.isArray(input) ? input : toIssues(input)
    super(`Validation failed: ${issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
    this.name = 'ValidationError'
    this.issues = issues
  }

  /** Message keys by dot path: `{ 'budget.currency': ['validation.currency'] }`. */
  get errors(): Record<string, string[]> {
    return groupByPath(this.issues, (i) => i.message)
  }

  /** Translated messages by dot path, for responses. */
  messages(translate?: Translate): Record<string, string[]> {
    return groupByPath(this.issues, (i) => formatMessage(i, translate))
  }
}
