import { reactive, type UnwrapRef } from 'vue'

/** `X-CSRF-Token` from the page's `<meta name="csrf-token">` (rendered by `<Assets>`), for hand-written `fetch`. */
export function csrfHeaders(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
  return token ? { 'x-csrf-token': token } : {}
}

export type Form<F extends object, R> = {
  data: UnwrapRef<F>
  /** First message per field from a 422 response; cleared on the next submit. */
  errors: Partial<Record<keyof F & string, string>> & Record<string, string | undefined>
  /** A message for failures that are not field errors (network, 403, 419, 500). */
  error: string | null
  processing: boolean
  /** Parsed JSON of the last successful response. */
  response: R
  post(url: string): Promise<boolean>
  put(url: string): Promise<boolean>
  patch(url: string): Promise<boolean>
  delete(url: string): Promise<boolean>
  reset(): void
  clearErrors(): void
}

/**
 * Reactive form state that submits JSON (with the CSRF token) and maps a 422 problem's `errors` to fields:
 * `const form = useForm({ title: '' }); if (await form.post(route('todos.store'))) …`.
 */
// biome-ignore lint/suspicious/noExplicitAny: the response type defaults to what the caller reads
export function useForm<F extends object, R = any>(initial: F): Form<F, R> {
  const copy = () => structuredClone(initial)
  const submit = async (method: string, url: string): Promise<boolean> => {
    form.processing = true
    form.clearErrors()
    try {
      const hasBody = method !== 'DELETE' || Object.keys(form.data as object).length > 0
      const res = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...csrfHeaders(),
        },
        body: hasBody ? JSON.stringify(form.data) : undefined,
      })
      const body = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : undefined
      if (res.ok) {
        form.response = body as UnwrapRef<R>
        return true
      }
      if (res.status === 422 && body?.errors) {
        for (const [field, messages] of Object.entries(body.errors as Record<string, string[]>))
          (form.errors as Record<string, string>)[field] = messages[0] ?? ''
      } else {
        form.error = body?.detail ?? body?.title ?? `${res.status} ${res.statusText}`
      }
      return false
    } catch (e) {
      form.error = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      form.processing = false
    }
  }
  const form = reactive({
    data: copy(),
    errors: {},
    error: null as string | null,
    processing: false,
    response: undefined as unknown,
    post: (url: string) => submit('POST', url),
    put: (url: string) => submit('PUT', url),
    patch: (url: string) => submit('PATCH', url),
    delete: (url: string) => submit('DELETE', url),
    reset() {
      form.data = copy() as never
      form.clearErrors()
    },
    clearErrors() {
      form.errors = {}
      form.error = null
    },
  })
  return form as unknown as Form<F, R>
}
