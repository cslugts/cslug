/**
 * A small, deterministic fake-data generator for factories (seeded PRNG: the same seed gives the same data).
 * Deliberately small; add what your tests need with plain functions.
 */
const FIRST = ['Ada', 'Rova', 'Giulia', 'Hery', 'Camille', 'Lova', 'Marco', 'Fara', 'Sofia', 'Tiana', 'Luca', 'Noa']
const LAST = ['Rakoto', 'Rossi', 'Martin', 'Rasoa', 'Bianchi', 'Dubois', 'Randria', 'Ferrari', 'Bernard', 'Andria']
const WORDS = [
  'baobab',
  'lemur',
  'tsingy',
  'zebu',
  'vanilla',
  'reef',
  'canyon',
  'forest',
  'river',
  'island',
  'road',
  'trail',
  'coast',
  'village',
  'market',
]
const COMPANY = ['Tours', 'Trails', 'Travel', 'Expeditions', 'Drive', 'Adventures']
const MOBILE: Record<string, [string, string[]]> = {
  MG: ['+261', ['32', '33', '34', '38']],
  FR: ['+33', ['6', '7']],
  IT: ['+39', ['347', '333', '320']],
  GB: ['+44', ['7']],
  US: ['+1', ['202', '415']],
}

const hashCache = new Map<string, string>()

export class Fake {
  private state: number

  constructor(seed = 42) {
    this.state = seed >>> 0
  }

  seed(seed: number): this {
    this.state = seed >>> 0
    return this
  }

  /** A float in [0, 1) (mulberry32). */
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(min = 0, max = 1000): number {
    return min + Math.floor(this.random() * (max - min + 1))
  }
  bool(): boolean {
    return this.random() < 0.5
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.random() * items.length)] as T
  }
  digits(n: number): string {
    return Array.from({ length: n }, () => this.int(0, 9)).join('')
  }
  firstName(): string {
    return this.pick(FIRST)
  }
  lastName(): string {
    return this.pick(LAST)
  }
  name(): string {
    return `${this.firstName()} ${this.lastName()}`
  }
  company(): string {
    return `${this.pick(WORDS).replace(/^./, (c) => c.toUpperCase())} ${this.pick(COMPANY)}`
  }
  word(): string {
    return this.pick(WORDS)
  }
  words(n: number): string {
    return Array.from({ length: n }, () => this.word()).join(' ')
  }
  sentence(words = 6): string {
    const s = this.words(words)
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`
  }
  email(): string {
    return `${this.firstName().toLowerCase()}.${this.lastName().toLowerCase()}${this.int(1, 999)}@example.test`
  }
  /** A plausible mobile number in E.164 for MG, FR, IT, GB or US. */
  phone(country: keyof typeof MOBILE | string = 'MG'): string {
    const [code, prefixes] = MOBILE[country] ?? (MOBILE.MG as [string, string[]])
    const prefix = this.pick(prefixes)
    return `${code}${prefix}${this.digits(9 - prefix.length + (code === '+1' ? 1 : 0))}`
  }
  /** `'YYYY-MM-DD'` between two dates (inclusive). */
  date(from = '2027-01-01', to = '2027-12-31'): string {
    const a = Date.parse(`${from}T00:00:00Z`)
    const b = Date.parse(`${to}T00:00:00Z`)
    return new Date(a + Math.floor(this.random() * ((b - a) / 86_400_000 + 1)) * 86_400_000).toISOString().slice(0, 10)
  }
  /** An argon2id hash of `plain`, cheap parameters, cached (for test users). */
  passwordHash(plain: string): string {
    let hash = hashCache.get(plain)
    if (!hash) {
      hash = Bun.password.hashSync(plain, { algorithm: 'argon2id', memoryCost: 1024, timeCost: 1 })
      hashCache.set(plain, hash)
    }
    return hash
  }
}
