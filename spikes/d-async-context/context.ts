import { AsyncLocalStorage } from 'node:async_hooks'

/** What cslug keeps per unit of work (see docs/architecture.md § Ambient context). */
export type Ctx = { requestId: string; locale: string; userId: string | null; tx: { depth: number } | null }
export const als = new AsyncLocalStorage<Ctx>()
export const ctx = () => {
  const c = als.getStore()
  if (!c) throw new Error('no context')
  return c
}
