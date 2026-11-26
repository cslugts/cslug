import { reactive, watch } from 'vue'

const stores = new Map<string, object>()

/**
 * State shared by every island on the page: `export const useCurrency = defineStore('currency', () => ({ code: 'EUR' }))`.
 * `persist` keeps it in localStorage. On the server each call returns the initial state (never shared between
 * requests).
 */
export function defineStore<S extends object>(
  name: string,
  init: () => S,
  options: { persist?: boolean } = {},
): () => S {
  return () => {
    if (typeof window === 'undefined') return reactive(init()) as S
    let store = stores.get(name) as S | undefined
    if (!store) {
      let initial = init()
      const key = `cslug:store:${name}`
      if (options.persist) {
        try {
          const saved = localStorage.getItem(key)
          if (saved) initial = { ...initial, ...JSON.parse(saved) }
        } catch {}
      }
      store = reactive(initial) as S
      stores.set(name, store)
      if (options.persist) watch(store, (value) => localStorage.setItem(key, JSON.stringify(value)), { deep: true })
    }
    return store
  }
}
