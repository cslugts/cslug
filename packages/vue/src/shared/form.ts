import { reactive, type UnwrapRef } from 'vue'
import { type HttpResult, type Progress, send } from './http'

export { csrfHeaders } from './http'

/** The callbacks of a submission (Inertia's names), on the form and per call; the form's run first. */
export type FormCallbacks<R> = {
  /** Before sending; return `false` to cancel. */
  onBefore?: () => boolean | undefined | void
  onStart?: () => void
  /** Upload progress (requests with files). */
  onProgress?: (progress: Progress) => void
  /** A 2xx: the JSON response, and where the server redirects (the page goes there after the callbacks). */
  onSuccess?: (response: unknown, info: { redirect?: string }) => void
  /** A failure: `errors` per field for a 422 (else `{}`), and the status and message. */
  onError?: (errors: Record<string, string>, info: { status: number; message: string | null }) => void
  /** Cancelled by `cancel()` or a newer submission. */
  onCancel?: () => void
  /** After any outcome. */
  onFinish?: () => void
}

export type SubmitOptions<R> = FormCallbacks<R> & {
  /** Follow a server `redirect()` (default true); false leaves the page and gives `redirect` to `onSuccess`. */
  followRedirects?: boolean
  headers?: Record<string, string>
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

export type Form<F extends object, R> = {
  data: UnwrapRef<F>
  /** First message per field from a 422 response; cleared on the next submit. */
  errors: Partial<Record<keyof F & string, string>> & Record<string, string | undefined>
  hasErrors: boolean
  /** A message for failures that are not field errors (network, 403, 419, 500). */
  error: string | null
  processing: boolean
  /** Upload progress of the request in flight (requests with files), else null. */
  progress: Progress | null
  /** The data differs from its defaults (the initial values, or the last `defaults()`). */
  isDirty: boolean
  /** The last submission succeeded. */
  wasSuccessful: boolean
  /** True for 2 seconds after a success (a "Saved" message). */
  recentlySuccessful: boolean
  /** Parsed JSON of the last successful response. */
  response: R
  /**
   * Submit: from a `<form>` event (`@submit.prevent="form.submit"`: its `action`, `method` and `_method`), or with a
   * method and URL. Resolves to true on a 2xx.
   */
  submit(event: Event, options?: SubmitOptions<R>): Promise<boolean>
  submit(method: Method, url: string, options?: SubmitOptions<R>): Promise<boolean>
  get(url: string, options?: SubmitOptions<R>): Promise<boolean>
  post(url: string, options?: SubmitOptions<R>): Promise<boolean>
  put(url: string, options?: SubmitOptions<R>): Promise<boolean>
  patch(url: string, options?: SubmitOptions<R>): Promise<boolean>
  delete(url: string, options?: SubmitOptions<R>): Promise<boolean>
  /** Abort the submission in flight (`onCancel`). */
  cancel(): void
  /** Change the data just before it is sent: `form.transform((d) => ({ ...d, remember: !!d.remember }))`. */
  transform(fn: (data: UnwrapRef<F>) => Record<string, unknown>): Form<F, R>
  /** Set errors by hand: `setError('email', '…')` or `setError({ email: '…' })`. */
  setError(field: string | Record<string, string>, message?: string): void
  clearErrors(...fields: string[]): void
  /** Back to the defaults: every field, or the ones named. Errors are cleared too. */
  reset(...fields: (keyof F & string)[]): void
  /** The current data (or one field's value) becomes the defaults `reset()` and `isDirty` compare with. */
  defaults(field?: keyof F & string, value?: unknown): void
}

const RECENT_MS = 2000

/** A deep copy that also reads Vue's reactive proxies (structuredClone cannot) and keeps files and dates. */
function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T
  return value
}

/**
 * Reactive form state that submits without reloading the page: JSON (or multipart with files) with the CSRF token,
 * 422 errors mapped to fields, callbacks, and a server `redirect()` followed. Works with web routes and API routes.
 *
 * ```ts
 * const form = useForm({ title: '' }, { onSuccess: () => form.reset() })
 * // <form :action="route('todos.store')" method="post" @submit.prevent="form.submit">
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: the response type defaults to what the caller reads
export function useForm<F extends object, R = any>(initial: F, callbacks: FormCallbacks<R> = {}): Form<F, R> {
  let defaults = clone(initial)
  let transform: ((data: UnwrapRef<F>) => Record<string, unknown>) | undefined
  let controller: AbortController | undefined
  let recent: ReturnType<typeof setTimeout> | undefined

  const run = async (method: string, url: string, options: SubmitOptions<R> = {}): Promise<boolean> => {
    const each = <K extends keyof FormCallbacks<R>>(name: K, ...args: Parameters<NonNullable<FormCallbacks<R>[K]>>) => {
      const results = [callbacks[name], options[name]].map((fn) =>
        (fn as ((...a: unknown[]) => unknown) | undefined)?.(...args),
      )
      return results
    }
    if (each('onBefore').includes(false)) return false
    controller?.abort() // a newer submission replaces the one in flight
    const own = new AbortController()
    controller = own
    form.processing = true
    form.progress = null
    form.wasSuccessful = false
    form.clearErrors()
    each('onStart')
    const data = transform ? transform(form.data) : (form.data as Record<string, unknown>)
    let result: HttpResult<R>
    try {
      result = await send<R>(method, url, data, {
        signal: own.signal,
        ...(options.headers ? { headers: options.headers } : {}),
        onProgress: (p) => {
          form.progress = p
          each('onProgress', p)
        },
      })
    } finally {
      if (controller === own) {
        form.processing = false
        controller = undefined
      }
    }
    if (result.cancelled) {
      each('onCancel')
      each('onFinish')
      return false
    }
    if (result.ok) {
      form.response = result.data as UnwrapRef<R>
      form.wasSuccessful = true
      form.recentlySuccessful = true
      clearTimeout(recent)
      recent = setTimeout(() => {
        form.recentlySuccessful = false
      }, RECENT_MS)
      each('onSuccess', result.data, result.redirect ? { redirect: result.redirect } : {})
      each('onFinish')
      if (result.redirect && options.followRedirects !== false && typeof window !== 'undefined')
        window.location.assign(result.redirect)
      return true
    }
    form.errors = result.errors as never
    form.error = result.error
    each('onError', result.errors, { status: result.status, message: result.error })
    each('onFinish')
    return false
  }

  const fromEvent = (event: Event): [string, string] => {
    const el = (event.currentTarget ?? event.target) as HTMLFormElement | null
    if (!el || typeof el.getAttribute !== 'function')
      throw new Error('form.submit(event) needs the submit event of a <form>: @submit.prevent="form.submit"')
    event.preventDefault?.()
    const override = (el.querySelector?.('input[name="_method"]') as HTMLInputElement | null)?.value
    return [override || el.getAttribute('method') || 'get', el.getAttribute('action') || window.location.href]
  }

  const form = reactive({
    data: clone(initial),
    errors: {} as Record<string, string | undefined>,
    error: null as string | null,
    processing: false,
    progress: null as Progress | null,
    wasSuccessful: false,
    recentlySuccessful: false,
    response: undefined as unknown,
    get hasErrors(): boolean {
      return Object.values(this.errors).some(Boolean)
    },
    get isDirty(): boolean {
      return JSON.stringify(this.data) !== JSON.stringify(defaults)
    },
    submit(target: Event | Method, url?: string | SubmitOptions<R>, options?: SubmitOptions<R>) {
      if (typeof target === 'string') return run(target, url as string, options)
      const [method, action] = fromEvent(target)
      return run(method, action, url as SubmitOptions<R> | undefined)
    },
    get: (url: string, options?: SubmitOptions<R>) => run('GET', url, options),
    post: (url: string, options?: SubmitOptions<R>) => run('POST', url, options),
    put: (url: string, options?: SubmitOptions<R>) => run('PUT', url, options),
    patch: (url: string, options?: SubmitOptions<R>) => run('PATCH', url, options),
    delete: (url: string, options?: SubmitOptions<R>) => run('DELETE', url, options),
    cancel() {
      controller?.abort()
    },
    transform(fn: (data: UnwrapRef<F>) => Record<string, unknown>) {
      transform = fn
      return form
    },
    setError(field: string | Record<string, string>, message?: string) {
      Object.assign(form.errors, typeof field === 'string' ? { [field]: message ?? '' } : field)
    },
    clearErrors(...fields: string[]) {
      if (!fields.length) {
        form.errors = {}
        form.error = null
      } else for (const f of fields) delete form.errors[f]
    },
    reset(...fields: string[]) {
      const fresh = clone(defaults) as Record<string, unknown>
      if (!fields.length) form.data = fresh as never
      else for (const f of fields) (form.data as Record<string, unknown>)[f] = fresh[f]
      form.clearErrors(...fields)
    },
    defaults(field?: string, value?: unknown) {
      if (field === undefined) defaults = clone(form.data) as F
      else
        (defaults as Record<string, unknown>)[field] =
          value === undefined ? clone((form.data as Record<string, unknown>)[field]) : value
    },
  })
  return form as unknown as Form<F, R>
}
