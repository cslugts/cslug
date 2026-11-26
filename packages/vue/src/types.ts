/** `defineOptions({ lang: ['todos'] })` in an island: the translation namespaces it needs in the browser. */
declare module 'vue' {
  interface ComponentCustomOptions {
    lang?: string[]
  }
  interface ComponentCustomProps {
    /** Make this component an island: load, idle, visible, none, media:(…). */
    hydrate?: 'load' | 'idle' | 'visible' | 'none' | `media:${string}`
  }
}

export {}
