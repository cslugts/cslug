/**
 * `bun create cslug` can run a copy of create-cslug that Bun cached long ago, and every `@cslug/*` package of the
 * new app is pinned to the scaffolder's own version. So the scaffolder first asks npm for the latest release and,
 * when it is older, runs that one instead (once: `CSLUG_NO_UPDATE_CHECK` is set for the child).
 */

/** True when `a` is a later release than `b` (`x.y.z`; a pre-release is older than its release). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre] = v.split('-')
    return { nums: core.split('.').map((n) => Number(n) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d !== 0) return d > 0
  }
  if (x.pre === y.pre) return false
  if (!x.pre) return true
  if (!y.pre) return false
  return x.pre > y.pre
}

/** The latest create-cslug on npm, or undefined when the registry cannot be reached in time (offline). */
export async function latestRelease(
  fetchFn: typeof fetch = fetch,
  registry = process.env.npm_config_registry ?? 'https://registry.npmjs.org',
): Promise<string | undefined> {
  try {
    const res = await fetchFn(`${registry.replace(/\/$/, '')}/create-cslug/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return undefined
    const { version } = (await res.json()) as { version?: unknown }
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/** The version to run instead of `current`, or undefined to go on with it. */
export async function newerRelease(current: string, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  if (process.env.CSLUG_NO_UPDATE_CHECK) return undefined
  const latest = await latestRelease(fetchFn)
  return latest && isNewer(latest, current) ? latest : undefined
}
