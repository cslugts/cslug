/** `cslug.config.ts`: framework-level settings (assets, processes for `cslug start`). */
export type CslugConfig = {
  assets?: { entries?: Record<string, string>; scss?: boolean; tailwind?: boolean }
  processes?: {
    web?: { instances?: number } | false
    worker?: { queues?: string[]; concurrency?: number }[] | false
    scheduler?: boolean
  }
  /** Seconds a child gets to finish after SIGTERM before it is killed (default 30). */
  shutdownTimeout?: number
}
/** Typed helper for `cslug.config.ts`: `export default defineCslugConfig({ … })`. */
export const defineCslugConfig = (config: CslugConfig): CslugConfig => config
