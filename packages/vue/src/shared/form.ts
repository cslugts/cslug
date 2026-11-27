import { formatIcu, formatMessage, type Issue } from '@cslug/validation'
import { reactive, type UnwrapRef } from 'vue'
import { pageData } from '../client/data'
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

/** A schema `form.validate()` can check fields with in the browser (a `v` schema: the server's validator). */
export type ClientSchema = {
  safeParse(input: unknown): { success: true } | { success: false; error: { issues: Issue[] } }
}

/** `useForm(initial, options)`: the callbacks, and what live validation needs. */
export type FormOptions<R> = FormCallbacks<R> & {
  /** Where `submit()` (without arguments) and server-side `validate()` send the form. */
  action?: string
  method?: Method
  /** Check fields in the browser with the same `v` schema as the server (no request). */
  schema?: ClientSchema
  /**
   * `client` (the schema, instantly), `server` (a validate-only request to the route, debounced: needs
   * `.validates(schema)` on it), or `both` (the server when the schema passes: unique emails…). Default: `client`
   * with a schema, else `server`.
   */
  validate?: 'client' | 'server' | 'both'
  /** Debounce of server-side validation, in ms (default 300). */
  validationTimeout?: number
}

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
  /** A server-side validation is in flight. */
  validating: boolean
  /**
   * Check fields now (default: the touched ones), in the browser or on the server (`options.validate`), and set or
   * clear their errors. `event` (an input's blur) gives the `<form>` to validate against. Resolves to true when valid.
   */
  validate(fields?: string | string[], event?: Event): Promise<boolean>
  /** Mark fields as touched (what `validate()` without fields checks). */
  touch(...fields: string[]): void
  /** Was the field (or any field) touched? */
  touched(field?: string): boolean
  /** Touched, validated and without an error. */
  valid(field: string): boolean
  /** Has an error (from validation or a submission). */
  invalid(field: string): boolean
  /**
   * Submit: from a `<form>` event (`@submit.prevent="form.submit"`: its `action`, `method` and `_method`), or with a
   * method and URL. Resolves to true on a 2xx.
   */
  submit(event: Event, options?: SubmitOptions<R>): Promise<boolean>
  /** With `options.action` (and `method`, default post). */
  submit(): Promise<boolean>
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

/** A validation message in the page's language: the `validation` namespace if the island loaded it, else English. */
const message = (issue: Issue) =>
  formatMessage(issue, (key, params) => {
    const data = pageData()
    const text = data.messages[key]
    return text === undefined ? undefined : formatIcu(text, params, data.locale)
  })
const matches = (path: string, field: string) => path === field || path.startsWith(`${field}.`)
/** The data without files: validate-only requests never upload. */
const withoutFiles = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.filter((v) => !(typeof Blob !== 'undefined' && v instanceof Blob)).map(withoutFiles)
    : value && typeof value === 'object' && !(value instanceof Date)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => !(typeof Blob !== 'undefined' && v instanceof Blob))
            .map(([k, v]) => [k, withoutFiles(v)]),
        )
      : value

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
export function useForm<F extends object, R = any>(initial: F, callbacks: FormOptions<R> = {}): Form<F, R> {
  let defaults = clone(initial)
  let target: [string, string] | undefined = callbacks.action
    ? [callbacks.method ?? 'post', callbacks.action]
    : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let waiting: { fields: Set<string>; resolvers: ((valid: boolean) => void)[] } = { fields: new Set(), resolvers: [] }
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
    target = [method, url]
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

  const payload = () => (transform ? transform(form.data) : (form.data as Record<string, unknown>))

  /** Replace the errors of `fields` (and their nested paths) with `errors`. */
  const setFieldErrors = (fields: string[], errors: Record<string, string>) => {
    for (const key of Object.keys(form.errors)) if (fields.some((f) => matches(key, f))) delete form.errors[key]
    for (const [key, text] of Object.entries(errors)) if (fields.some((f) => matches(key, f))) form.errors[key] = text
    for (const f of fields) form.validated[f] = true
  }

  const inBrowser = (fields: string[]): Record<string, string> => {
    const result = (callbacks.schema as ClientSchema).safeParse(payload())
    if (result.success) return {}
    const errors: Record<string, string> = {}
    for (const issue of result.error.issues) {
      const path = issue.path.join('.')
      if (fields.some((f) => matches(path, f)) && errors[path] === undefined) errors[path] = message(issue)
    }
    return errors
  }

  /** Debounced validate-only requests: fields asked for within the timeout go in one request. */
  const onServer = (fields: string[]): Promise<boolean> => {
    if (!target)
      throw new Error(
        'form.validate() needs the route: useForm(data, { action: route(…) }), form.validate(field, $event), or a first submit',
      )
    const [method, url] = target
    for (const f of fields) waiting.fields.add(f)
    clearTimeout(timer)
    return new Promise((resolve) => {
      waiting.resolvers.push(resolve)
      timer = setTimeout(async () => {
        const batch = waiting
        waiting = { fields: new Set(), resolvers: [] }
        const names = [...batch.fields]
        form.validating = true
        const result = await send(method, url, withoutFiles(payload()) as Record<string, unknown>, {
          headers: { 'x-cslug-validate': names.join(',') },
        })
        form.validating = false
        if (result.ok || result.status === 422) setFieldErrors(names, result.errors)
        else if (!result.cancelled) form.error = result.error
        const valid = result.ok
        for (const r of batch.resolvers) r(valid)
      }, callbacks.validationTimeout ?? 300)
    })
  }

  /** A `<form>`'s method (`_method` first) and action. */
  const fromForm = (el: HTMLFormElement): [string, string] => {
    const override = (el.querySelector?.('input[name="_method"]') as HTMLInputElement | null)?.value
    return [override || el.getAttribute('method') || 'get', el.getAttribute('action') || window.location.href]
  }

  const fromEvent = (event: Event): [string, string] => {
    const el = (event.currentTarget ?? event.target) as HTMLFormElement | null
    if (!el || typeof el.getAttribute !== 'function')
      throw new Error('form.submit(event) needs the submit event of a <form>: @submit.prevent="form.submit"')
    event.preventDefault?.()
    return fromForm(el)
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
    validating: false,
    touchedFields: {} as Record<string, true>,
    validated: {} as Record<string, true>,
    async validate(fields?: string | string[], event?: Event): Promise<boolean> {
      const element = (event?.target as HTMLInputElement | null)?.form
      if (element) target = fromForm(element)
      const names = fields === undefined ? Object.keys(form.touchedFields) : Array.isArray(fields) ? fields : [fields]
      if (!names.length) return true
      form.touch(...names)
      const mode = callbacks.validate ?? (callbacks.schema ? 'client' : 'server')
      if (mode !== 'server' && callbacks.schema) {
        const errors = inBrowser(names)
        setFieldErrors(names, errors)
        if (mode === 'client' || Object.keys(errors).length) return !Object.keys(errors).length
      }
      return onServer(names)
    },
    touch(...fields: string[]) {
      for (const f of fields) form.touchedFields[f] = true
    },
    touched(field?: string) {
      return field === undefined ? Object.keys(form.touchedFields).length > 0 : !!form.touchedFields[field]
    },
    valid(field: string) {
      return !!form.touchedFields[field] && !!form.validated[field] && !form.invalid(field)
    },
    invalid(field: string) {
      return Object.entries(form.errors).some(([key, text]) => !!text && matches(key, field))
    },
    get hasErrors(): boolean {
      return Object.values(this.errors).some(Boolean)
    },
    get isDirty(): boolean {
      return JSON.stringify(this.data) !== JSON.stringify(defaults)
    },
    submit(how?: Event | Method, url?: string | SubmitOptions<R>, options?: SubmitOptions<R>) {
      if (how === undefined) {
        if (!callbacks.action) throw new Error('form.submit() without arguments needs useForm(data, { action })')
        return run(callbacks.method ?? 'post', callbacks.action)
      }
      if (typeof how === 'string') return run(how, url as string, options)
      const [method, action] = fromEvent(how)
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
