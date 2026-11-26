import { CslugError } from './errors'

/** `'500ms'`, `'30s'`, `'10m'`, `'1h30m'`, `'1d'`, `'2w'`, or milliseconds. */
export type Duration = string | number

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g

/** Milliseconds in a duration. Throws on anything it does not understand (no silent zero). */
export function parseDuration(duration: Duration): number {
  if (typeof duration === 'number') {
    if (!Number.isFinite(duration) || duration < 0)
      throw new CslugError('duration.invalid', `Invalid duration ${duration}`)
    return duration
  }
  const text = duration.trim().toLowerCase()
  let total = 0
  let consumed = ''
  for (const [whole, value, unit] of text.matchAll(PART)) {
    total += Number(value) * (UNITS[unit as string] as number)
    consumed += whole
  }
  if (!text || consumed !== text.replace(/\s+/g, '')) {
    throw new CslugError('duration.invalid', `Invalid duration "${duration}" (use e.g. "30s", "10m", "1h30m", "2d")`)
  }
  return Math.round(total)
}
