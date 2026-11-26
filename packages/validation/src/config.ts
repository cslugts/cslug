/** Hooks that @cslug/core sets at boot, so validation follows the app's clock and time zone. */
export const settings = {
  /** Today's date as `YYYY-MM-DD`. Core replaces this with its `Clock`; the default is UTC. */
  today: (): string => new Date().toISOString().slice(0, 10),
}

export function configure(options: Partial<typeof settings>): void {
  Object.assign(settings, options)
}
