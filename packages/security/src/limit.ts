import { type RateLimit, RateLimiter, TooManyRequestsError } from '@cslug/core'
import type { MiddlewareFn } from '@cslug/http'

/**
 * One rate limit over every request from an IP (`'600/min'`), through the `RateLimiter` (shared with
 * @cslug/redis). Past it: 429 with `Retry-After`. Paths starting with one of `except` are not counted.
 */
export const ipLimit =
  (limit: RateLimit, options: { except?: string[] } = {}): MiddlewareFn =>
  async (ctx, next) => {
    const ip = ctx.request.ip()
    const except = options.except ?? ['/health/']
    if (!ip || except.some((p) => ctx.request.path.startsWith(p))) return next()
    const result = await ctx.resolve(RateLimiter).hit(`security:ip:${ip}`, limit)
    if (!result.allowed) throw new TooManyRequestsError(result.retryAfter)
    return next()
  }
