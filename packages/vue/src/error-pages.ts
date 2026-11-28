import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ErrorPages, HttpContext, Problem } from '@cslug/http'
import type { Component } from 'vue'
import { ViewResponse } from './render'

/**
 * Error views by convention: `resources/views/errors/<status>.vue`, else `4xx.vue` / `5xx.vue`, rendered for
 * browsers when no error handler answered (guide 08). The view gets the props it declares among `status`, `code`,
 * `title`, `requestId`, `errors`, `params`, and in development `detail` and `stack` for 5xx.
 */
export function errorPages(root: string): ErrorPages {
  const dir = join(root, 'resources/views/errors')
  return async (_error: unknown, ctx: HttpContext, problem: Problem) => {
    const file = [`${problem.status}.vue`, `${String(problem.status).charAt(0)}xx.vue`]
      .map((name) => join(dir, name))
      .find((path) => existsSync(path))
    if (!file) return undefined
    const page = ((await import(file)) as { default: Component }).default
    const declared = (page as { props?: Record<string, unknown> | string[] }).props
    const names = Array.isArray(declared) ? declared : Object.keys(declared ?? {})
    const props = Object.fromEntries(
      names.filter((n) => n in problem).map((n) => [n, (problem as Record<string, unknown>)[n]]),
    )
    return new ViewResponse(page, props, { status: problem.status }).toResponse(ctx)
  }
}
