/** Browser side: mount every <cslug-island> when its hydrate condition is met. */
import { createSSRApp } from 'vue'
import { islands } from './islands.generated'

type Win = Window & { __islands?: { id: string; mode: string; ms: number }[] }
const log: { id: string; mode: string; ms: number }[] = ((window as Win).__islands = [])

for (const el of document.querySelectorAll<HTMLElement>('cslug-island')) {
  const id = el.dataset.island as string
  const mode = el.dataset.hydrate ?? 'load'
  const props = JSON.parse(el.dataset.props ?? '{}')
  const mount = async () => {
    const t0 = performance.now()
    const load = islands[id]
    if (!load) throw new Error(`unknown island ${id}`)
    const component = (await load()).default
    createSSRApp(component, props).mount(el)
    log.push({ id, mode, ms: performance.now() - t0 })
    el.dataset.mounted = 'true'
  }
  if (mode === 'load') mount()
  else if (mode === 'idle') ('requestIdleCallback' in window ? requestIdleCallback : setTimeout)(() => mount())
  else if (mode === 'visible') {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        mount()
      }
    })
    io.observe(el.firstElementChild ?? el)
  } else if (mode.startsWith('media:')) {
    const mq = matchMedia(mode.slice(6))
    if (mq.matches) mount()
    else mq.addEventListener('change', () => mount(), { once: true })
  }
}
