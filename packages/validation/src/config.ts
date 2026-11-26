/** Hooks that @cslug/core sets at boot, so validation follows the app's clock and time zone. */
export const settings = {
  /** Today's date as `YYYY-MM-DD`. Core replaces this with its `Clock`; the default is UTC. */
  today: (): string => new Date().toISOString().slice(0, 10),
}

/** Replace the hooks in `settings` (called by @cslug/core at boot). */
export function configure(options: Partial<typeof settings>): void {
  Object.assign(settings, options)
}
