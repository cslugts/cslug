/** `X-CSRF-Token` from the page's `<meta name="csrf-token">` (rendered by `<Assets>`), for hand-written `fetch`. */
export function csrfHeaders(): Record<string, string> {
  if (typeof document === 'undefined') return {}
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')
  return token ? { 'x-csrf-token': token } : {}
}

/** Sent with every request `useForm` and `http` make: `redirect()` then answers with the URL instead of a 3xx. */
export const REQUEST_HEADER = 'x-cslug-request'
/** Where `redirect()` sends the page, for a request from `useForm` / `http` (with a 204). */
export const REDIRECT_HEADER = 'x-cslug-redirect'

export type Progress = { loaded: number; total: number; percentage: number }

/** What a request returns: never throws for HTTP errors or network failures. */
export type HttpResult<T = unknown> = {
  ok: boolean
  /** 0 for a network failure or a cancelled request. */
  status: number
  /** The parsed JSON body of a successful response. */
  data: T
  /** First message per field of a 422 response. */
  errors: Record<string, string>
  /** A message for failures that are not field errors (network, 403, 419, 500). */
  error: string | null
  /** Where the server sent the page (`redirect()` on the server). */
  redirect?: string
  cancelled?: boolean
}

export type RequestOptions = {
  headers?: Record<string, string>
  /** Upload progress (requests with files). */
  onProgress?: (progress: Progress) => void
  signal?: AbortSignal
}

const isFile = (v: unknown): v is Blob => typeof Blob !== 'undefined' && v instanceof Blob
const hasFiles = (v: unknown): boolean =>
  isFile(v) || (Array.isArray(v) ? v.some(hasFiles) : !!v && typeof v === 'object' && Object.values(v).some(hasFiles))

/**
 * A multipart body with the server's key syntax (`a[b]`, `list[]`): what `request.body()` nests back. Lists of
 * objects do not round-trip; keep requests with files flat.
 */
export function toFormData(data: Record<string, unknown>): FormData {
  const form = new FormData()
  const add = (key: string, value: unknown) => {
    if (value === undefined) return
    if (isFile(value)) form.append(key, value)
    else if (Array.isArray(value)) for (const item of value) add(`${key}[]`, item)
    else if (value !== null && typeof value === 'object' && !(value instanceof Date))
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v)
    else form.append(key, value === null ? '' : value instanceof Date ? value.toISOString() : String(value))
  }
  for (const [k, v] of Object.entries(data)) add(k, v)
  return form
}

const errorsOf = (body: unknown): Record<string, string> => {
  const errors = (body as { errors?: Record<string, string[] | string> } | undefined)?.errors ?? {}
  return Object.fromEntries(Object.entries(errors).map(([k, m]) => [k, (Array.isArray(m) ? m[0] : m) ?? '']))
}

/** Upload with progress events (fetch has none). */
function xhrSend(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: FormData,
  options: RequestOptions,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    xhr.withCredentials = true
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) =>
      e.lengthComputable &&
      options.onProgress?.({ loaded: e.loaded, total: e.total, percentage: Math.round((e.loaded / e.total) * 100) })
    xhr.onload = () => {
      const responseHeaders = new Headers()
      for (const line of xhr
        .getAllResponseHeaders()
        .trim()
        .split(/[\r\n]+/)) {
        const at = line.indexOf(':')
        if (at > 0) responseHeaders.append(line.slice(0, at).trim(), line.slice(at + 1).trim())
      }
      const status = xhr.status === 1223 ? 204 : xhr.status
      resolve(
        new Response([101, 204, 205, 304].includes(status) ? null : xhr.responseText, {
          status,
          headers: responseHeaders,
        }),
      )
    }
    xhr.onerror = () => reject(new TypeError('Network error'))
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    options.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(body)
  })
}

/**
 * Send a request as cslug's front end does: JSON (or multipart when the data holds a `File`), `Accept: JSON`, the
 * CSRF token, the session cookie. 422 errors are mapped to fields; a server `redirect()` comes back as `redirect`.
 */
export async function send<T = unknown>(
  method: string,
  url: string,
  data?: Record<string, unknown>,
  options: RequestOptions = {},
): Promise<HttpResult<T>> {
  const result = (patch: Partial<HttpResult<T>>): HttpResult<T> => ({
    ok: false,
    status: 0,
    data: undefined as T,
    errors: {},
    error: null,
    ...patch,
  })
  const upper = method.toUpperCase()
  const bodyless = upper === 'GET' || upper === 'HEAD'
  let target = url
  if (bodyless && data && Object.keys(data).length) {
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(data))
      if (v !== undefined && v !== null) for (const item of Array.isArray(v) ? v : [v]) query.append(k, String(item))
    target += (url.includes('?') ? '&' : '?') + query
  }
  const withBody = !bodyless && !!data && (upper !== 'DELETE' || Object.keys(data).length > 0)
  const files = withBody && hasFiles(data)
  const headers: Record<string, string> = {
    accept: 'application/json',
    [REQUEST_HEADER]: '1',
    ...(withBody && !files ? { 'content-type': 'application/json' } : {}),
    ...csrfHeaders(),
    ...options.headers,
  }
  const body = withBody ? (files ? toFormData(data as Record<string, unknown>) : JSON.stringify(data)) : undefined
  try {
    const res =
      files && typeof XMLHttpRequest !== 'undefined'
        ? await xhrSend(upper, target, headers, body as FormData, options)
        : await fetch(target, { method: upper, credentials: 'same-origin', headers, body, signal: options.signal })
    const redirect = res.headers.get(REDIRECT_HEADER) ?? undefined
    const json = (res.headers.get('content-type') ?? '').includes('json')
      ? await res.json().catch(() => undefined)
      : undefined
    if (res.ok) return result({ ok: true, status: res.status, data: json as T, ...(redirect ? { redirect } : {}) })
    if (res.status === 422 && (json as { errors?: unknown } | undefined)?.errors)
      return result({ status: 422, errors: errorsOf(json), error: null })
    const problem = json as { detail?: string; title?: string } | undefined
    return result({ status: res.status, error: problem?.detail ?? problem?.title ?? `${res.status} ${res.statusText}` })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return result({ cancelled: true, error: null })
    return result({ error: e instanceof Error ? e.message : String(e) })
  }
}

/**
 * Requests that are not a form (a button, loading a list), with the same CSRF, JSON and error handling as
 * `useForm`: `const { ok, data } = await http.get<Todo[]>(route('api.todos.index'))`. Never throws for HTTP errors.
 */
export const http = {
  get: <T = unknown>(url: string, query?: Record<string, unknown>, options?: RequestOptions) =>
    send<T>('GET', url, query, options),
  post: <T = unknown>(url: string, data?: Record<string, unknown>, options?: RequestOptions) =>
    send<T>('POST', url, data ?? {}, options),
  put: <T = unknown>(url: string, data?: Record<string, unknown>, options?: RequestOptions) =>
    send<T>('PUT', url, data ?? {}, options),
  patch: <T = unknown>(url: string, data?: Record<string, unknown>, options?: RequestOptions) =>
    send<T>('PATCH', url, data ?? {}, options),
  delete: <T = unknown>(url: string, data?: Record<string, unknown>, options?: RequestOptions) =>
    send<T>('DELETE', url, data, options),
}
