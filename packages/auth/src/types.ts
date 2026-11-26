import type { AuthUser } from '@cslug/core'
import type { Auth } from './auth'

declare module '@cslug/http' {
  interface HttpContext {
    /** Who is making the request (loaded by `authenticate()`, in the web and api groups). */
    auth: Auth
    /** The signed-in user, or null. */
    user: AuthUser | null
  }
}
