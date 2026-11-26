import { type Component, defineComponent, h, useSSRContext } from 'vue'

/** What JSON delivers: bigint → string, Date → ISO string, recursively. */
export type Serialized<T> = T extends bigint
  ? string
  : T extends Date
    ? string
    : T extends (infer U)[]
      ? Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T

/** Runtime + type conversion for island props. */
export function serialize<T>(value: T): Serialized<T> {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Serialized<T>
}

/**
 * Server-side wrapper that the compile-time transform puts around `<X hydrate="…">`.
 * Renders the component with the *serialized* props (exactly what the browser will get, so hydration matches),
 * inside <cslug-island> carrying the island id, the hydrate mode and the props.
 */
export const CslugIsland = defineComponent({
  name: 'CslugIsland',
  inheritAttrs: false,
  props: {
    islandComponent: { type: [Object, Function], required: true },
    islandHydrate: { type: String, default: 'load' },
  },
  setup(props, { attrs }) {
    const ctx = useSSRContext<{ islands?: Set<string> }>()
    return () => {
      const component = props.islandComponent as Component & { __islandId?: string }
      const id = component.__islandId
      if (!id) throw new Error('hydrate used on a component that was not compiled by cslug (no __islandId)')
      ctx?.islands?.add(id)
      const data = serialize({ ...attrs })
      return h('cslug-island', { 'data-island': id, 'data-hydrate': props.islandHydrate, 'data-props': JSON.stringify(data) }, [
        h(component, data),
      ])
    }
  },
})
