import type { App } from 'vue'

/**
 * Hydrate the page's islands. Runs in the browser (resources/client.ts, bundled by `cslug build`, which resolves
 * @cslug/vue to its browser entry); this server-side version only exists so client code type-checks.
 */
export function mountIslands(
  _options: { setup?: (app: App, island: { id: string; element: HTMLElement }) => void } = {},
): void {
  throw new Error('mountIslands() runs in the browser: call it from resources/client.ts')
}
