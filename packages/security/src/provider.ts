import { Clock, type RateLimit, ServiceProvider } from '@cslug/core'
import { HttpKernel, Router } from '@cslug/http'
import { type CspOptions, csp } from './csp'
import { type IpFilterOptions, ipFilter } from './ip'
import { ipLimit } from './limit'
import { type SecurityTxtOptions, securityTxt } from './security-txt'

export type SecurityConfig = {
  /** A Content-Security-Policy with a per-request nonce on every response (default: on); false: off. */
  csp?: CspOptions | false
  /** One rate limit over every request from an IP (`'600/min'`); health checks are not counted. Default: off. */
  limit?: RateLimit | false
  /** Allow or deny addresses and CIDR ranges for the whole app. */
  ipFilter?: IpFilterOptions
  /** Serve `/.well-known/security.txt`. */
  securityTxt?: SecurityTxtOptions | false
}

/**
 * Adds the global middleware (IP filter, then the per-IP limit, then CSP) and `/.well-known/security.txt`, from
 * `config/security.ts`. List it after `HttpProvider`.
 */
export class SecurityProvider extends ServiceProvider {
  boot() {
    const config = this.app.config<SecurityConfig | undefined>('security') ?? {}
    const kernel = this.app.resolve(HttpKernel)
    if (config.ipFilter?.allow || config.ipFilter?.deny) kernel.global.push(ipFilter(config.ipFilter))
    if (config.limit) kernel.global.push(ipLimit(config.limit))
    if (config.csp !== false) kernel.global.push(csp(config.csp ?? {}))
    if (config.securityTxt) this.securityTxtRoute(config.securityTxt)
  }

  private securityTxtRoute(options: SecurityTxtOptions) {
    const url = this.app.config<string | undefined>('app.url')
    const body = securityTxt(options, {
      expires: this.app.resolve(Clock).add('365d'),
      canonical: url ? new URL('/.well-known/security.txt', url).toString() : undefined,
    })
    this.app.resolve(Router).load((r) => {
      r.get(
        '/.well-known/security.txt',
        () => new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
      ).name('security.txt')
    })
  }
}
