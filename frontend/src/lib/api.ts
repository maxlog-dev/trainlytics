export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

let _token: string | null = null
let _onUnauthorized: (() => void) | null = null
let _onSessionRefreshed: ((token: string) => void) | null = null
// Bumped whenever the session ends or changes account (the token is cleared:
// logout, expiry, another account's token). A request remembers it when it
// starts and is neither re-sent with a newer session's token nor answered
// after its session ended; a refresh that was in flight can't sign back in.
let _sessionEpoch = 0
// Set by a logout until the next login: a refresh answered after the logout
// would re-set the refresh cookie it clears
let _refreshBlocked = false

const REFRESH_TIMEOUT_MS = 15_000
const RENEW_FAILED = 'Could not renew the session. Check your connection and try again.'

export function setToken(token: string | null): void {
  _token = token
  if (token === null) _sessionEpoch++
  else _refreshBlocked = false
}

/** The current session epoch (see above), for callers that bind their own async steps to a session. */
export function sessionEpoch(): number {
  return _sessionEpoch
}

/** From a logout until the next login, no refresh starts (each resolves `unauthorized` at once). */
export function blockRefresh(): void {
  _refreshBlocked = true
}

export function setUnauthorizedHandler(handler: () => void): void {
  _onUnauthorized = handler
}

/** Called with the new access token after every successful refresh (launch, 401, or a request without a token). */
export function setSessionRefreshedHandler(handler: ((token: string) => void) | null): void {
  _onSessionRefreshed = handler
}

/**
 * What a refresh found. `unauthorized`: the server refused the refresh cookie
 * (401: expired, logged out), or the session it was for has ended, so the
 * session is over. `unavailable`: it couldn't be asked (offline, timeout,
 * 403/5xx, no token in the answer), which says nothing about the session, so
 * nobody is logged out for it.
 */
export type RefreshResult = { token: string } | { error: 'unauthorized' | 'unavailable' }

// Single-flight refresh: the launch refresh, concurrent 401s and requests
// without a token share one POST /auth/refresh, within one session epoch (a
// refresh started for an ended session is no verdict on the next one).
let _refreshPromise: Promise<RefreshResult> | null = null
let _refreshEpoch = -1

async function postRefresh(epoch: number): Promise<RefreshResult> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REFRESH_TIMEOUT_MS)
  try {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', signal: abort.signal })
    if (res.status === 401) return { error: 'unauthorized' }
    if (!res.ok) return { error: 'unavailable' }
    const data = (await res.json()) as { access_token?: string }
    if (!data.access_token) return { error: 'unavailable' }
    if (epoch !== _sessionEpoch) return { error: 'unauthorized' }
    setToken(data.access_token)
    _onSessionRefreshed?.(data.access_token)
    return { token: data.access_token }
  } catch {
    return { error: 'unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

function joinsRefresh(): boolean {
  return _refreshPromise !== null && _refreshEpoch === _sessionEpoch && !_refreshBlocked
}

/**
 * Refreshes the access token from the HttpOnly refresh cookie, or joins this
 * session's refresh already in flight. On success the token is set, and the
 * session-refreshed handler has run, before the promise resolves.
 */
export function refreshSession(): Promise<RefreshResult> {
  if (_refreshBlocked) return Promise.resolve({ error: 'unauthorized' })
  if (_refreshPromise && joinsRefresh()) return _refreshPromise
  _refreshEpoch = _sessionEpoch
  const flight: Promise<RefreshResult> = postRefresh(_sessionEpoch).finally(() => {
    if (_refreshPromise === flight) _refreshPromise = null
  })
  _refreshPromise = flight
  return flight
}

/** Resolves once no refresh is in flight (logout waits, so a late refresh can't re-set the cookie). */
export async function settleRefresh(): Promise<void> {
  while (_refreshPromise) await _refreshPromise
}

/**
 * The access token, refreshed first if there is none: for requests made
 * outside `api` (an XHR upload). Null when there is no session, or when it
 * ended or changed account while refreshing.
 */
export async function getAccessToken(): Promise<string | null> {
  if (_token) return _token
  const epoch = _sessionEpoch
  const joined = joinsRefresh()
  const result = await refreshSession()
  if (epoch !== _sessionEpoch) return null
  if ('token' in result) return result.token
  if (result.error === 'unauthorized' && !joined) _onUnauthorized?.()
  return null
}

/** List fields whose items read better in the singular: "exercise 1", not "exercises 1". */
const LOC_ITEM_NAMES: Record<string, string> = { exercises: 'exercise', sets: 'set', segments: 'segment' }

/**
 * A validation error location for people: ["body", "exercises", 0, "sets", 1, "rpe"]
 * → "exercise 1 › set 2 › rpe". Drops the leading "body"; a list index joins the
 * name before it and counts from 1. Any other number (e.g. the character offset
 * in a JSON decode error, ["body", 123]) is left out.
 */
function formatErrorLoc(loc: unknown): string {
  if (!Array.isArray(loc)) return ''
  const parts = loc[0] === 'body' ? loc.slice(1) : loc
  const out: string[] = []
  let prevName: string | null = null
  for (const part of parts) {
    if (typeof part === 'number') {
      if (prevName !== null) out[out.length - 1] = `${LOC_ITEM_NAMES[prevName] ?? prevName} ${part + 1}`
      prevName = null
    } else {
      out.push(String(part))
      prevName = String(part)
    }
  }
  return out.join(' › ')
}

/**
 * FastAPI `detail` as text: a string as is; a validation error list (422) as
 * "where: msg" entries joined, not "[object Object]".
 */
export function formatErrorDetail(detail: unknown): string {
  if (detail == null || detail === '') return 'Request failed'
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => {
      if (!d || typeof d !== 'object' || !('msg' in d)) return String(d)
      const { msg, loc } = d as { msg: unknown; loc?: unknown }
      const where = formatErrorLoc(loc)
      return where ? `${where}: ${String(msg)}` : String(msg)
    })
    return msgs.length > 0 ? msgs.join('; ') : 'Request failed'
  }
  return JSON.stringify(detail)
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Session RPE is on the 1–10 scale; without this the API refuses a session rpe
    // (409), so a bundle from before that change can't save an inverted value
    'X-Session-Rpe-Scale': '10',
  }
  if (_token) headers['Authorization'] = `Bearer ${_token}`
  return fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isAuthPath = path.startsWith('/auth/')
  const epoch = _sessionEpoch
  // Logged out, or the session now belongs to another account (a refresh
  // returned it): nothing more is sent, re-sent or reported for this request
  const sessionChanged = () => !isAuthPath && epoch !== _sessionEpoch

  // No token (at launch, or after a refresh that couldn't reach the server):
  // get one first, joining the refresh in flight, instead of sending a request
  // that can only take a 401. At launch, pages rendered for a remembered
  // session wait here for the launch refresh. A refused refresh is reported
  // by whoever started it (AuthProvider at launch).
  if (!_token && !isAuthPath) {
    const joined = joinsRefresh()
    const result = await refreshSession()
    if (sessionChanged()) throw new Error('Unauthorized')
    if ('error' in result) {
      if (result.error === 'unavailable') throw new Error(RENEW_FAILED)
      if (!joined) _onUnauthorized?.()
      throw new Error('Unauthorized')
    }
  }

  let res = await send(method, path, body)
  if (sessionChanged()) throw new Error('Unauthorized')

  // Expired access token: refresh once and retry once. /auth/* 401s (wrong
  // password, a refused refresh) are passed through untouched.
  if (res.status === 401 && !isAuthPath) {
    const result = await refreshSession()
    if (sessionChanged()) throw new Error('Unauthorized')
    if ('token' in result) {
      res = await send(method, path, body)
      if (sessionChanged()) throw new Error('Unauthorized')
    } else if (result.error === 'unavailable') {
      // The session may be fine: keep it (and the cached data) and let the next call try again
      throw new Error(RENEW_FAILED)
    }
  }

  if (res.status === 401) {
    // A wrong password at /auth/login isn't a session ending
    if (!isAuthPath) _onUnauthorized?.()
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    const message = formatErrorDetail(err['detail'])
    console.error(`[api] ${method} ${path} → ${res.status}:`, message, err)
    throw new ApiError(message, res.status, err)
  }

  const data = res.status === 204 ? undefined : ((await res.json()) as T)
  // Its answer must not land in the next account's cache
  if (sessionChanged()) throw new Error('Unauthorized')
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
