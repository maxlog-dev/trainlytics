import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  blockRefresh,
  getAccessToken,
  refreshSession,
  setSessionRefreshedHandler,
  setToken,
  settleRefresh,
  setUnauthorizedHandler,
} from '../lib/api'

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function bearer(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string>)['Authorization']
}

describe('api 401 handling', () => {
  const fetchMock = vi.fn()
  const onUnauthorized = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    onUnauthorized.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    setToken('old-token')
    setUnauthorizedHandler(onUnauthorized)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockRefreshSucceeds() {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url === '/api/auth/refresh') return json(200, { access_token: 'new-token' })
      return bearer(init) === 'Bearer new-token' ? json(200, { ok: true }) : json(401)
    })
  }

  it('refreshes on 401 and retries with the new token', async () => {
    mockRefreshSucceeds()

    await expect(api.get('/exercises')).resolves.toEqual({ ok: true })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(refreshUrl).toBe('/api/auth/refresh')
    expect(refreshInit.method).toBe('POST')
    expect(refreshInit.credentials).toBe('include')
    expect(bearer(fetchMock.mock.calls[2][1] as RequestInit)).toBe('Bearer new-token')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('shares one refresh between concurrent 401s', async () => {
    mockRefreshSucceeds()

    await Promise.all([api.get('/a'), api.get('/b')])

    const refreshCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/auth/refresh')
    expect(refreshCalls).toHaveLength(1)
  })

  it('calls the unauthorized handler when refresh fails', async () => {
    fetchMock.mockImplementation(async () => json(401))

    await expect(api.get('/exercises')).rejects.toThrow('Unauthorized')

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('calls the unauthorized handler when the retry also returns 401', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/refresh' ? json(200, { access_token: 'new-token' }) : json(401),
    )

    await expect(api.get('/exercises')).rejects.toThrow('Unauthorized')

    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("does not replay a request after a 401 when the refresh returns another account", async () => {
    setSessionRefreshedHandler(() => {
      // AuthProvider ends the old account's session before adopting the new one
      setToken(null)
      setToken('new-token')
    })
    mockRefreshSucceeds()

    await expect(api.post('/sessions/strength', { exercises: [] })).rejects.toThrow('Unauthorized')

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/sessions/strength', '/api/auth/refresh'])
    expect(onUnauthorized).not.toHaveBeenCalled()
    setSessionRefreshedHandler(null)
  })

  it('keeps the session when the refresh after a 401 cannot reach the server', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/refresh' ? json(503) : json(401),
    )

    await expect(api.get('/exercises')).rejects.toThrow('Could not renew the session')

    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not attempt refresh for a 401 from /auth/login', async () => {
    fetchMock.mockResolvedValue(json(401, { detail: 'Invalid credentials' }))

    await expect(api.post('/auth/login', { username: 'a', password: 'b' })).rejects.toThrow('Unauthorized')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login')
    // A wrong password isn't a session ending: the login form shows the error
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('reports nothing for the 401 of a request whose session has ended', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (answer = r)))
    const pending = api.get('/exercises')
    await new Promise((r) => setTimeout(r, 0))
    setToken(null) // logout, then another account signs in
    setToken('other-token')

    answer(json(401))

    await expect(pending).rejects.toThrow('Unauthorized')
    expect(onUnauthorized).not.toHaveBeenCalled()
    // and it started no refresh
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('api launch refresh', () => {
  const fetchMock = vi.fn()
  const onUnauthorized = vi.fn()
  const onRefreshed = vi.fn()
  let refresh: { promise: Promise<Response>; resolve: (r: Response) => void }

  beforeEach(() => {
    fetchMock.mockReset()
    onUnauthorized.mockReset()
    onRefreshed.mockReset()
    let resolve!: (r: Response) => void
    refresh = { promise: new Promise<Response>((r) => (resolve = r)), resolve: (r) => resolve(r) }
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      // A copy per call: two refreshes may share the answer
      if (url === '/api/auth/refresh') return refresh.promise.then((r) => r.clone())
      return bearer(init) === 'Bearer new-token' ? json(200, { ok: true }) : json(401)
    })
    vi.stubGlobal('fetch', fetchMock)
    setToken(null)
    setUnauthorizedHandler(onUnauthorized)
    setSessionRefreshedHandler(onRefreshed)
  })

  afterEach(async () => {
    refresh.resolve(json(401))
    await new Promise((r) => setTimeout(r, 0))
    setSessionRefreshedHandler(null)
    vi.unstubAllGlobals()
  })

  const calledUrls = () => fetchMock.mock.calls.map((c) => c[0] as string)

  it('holds a request made without a token until the refresh in flight has one', async () => {
    const launch = refreshSession()
    const pending = api.get('/profile')
    await new Promise((r) => setTimeout(r, 0))
    expect(calledUrls()).toEqual(['/api/auth/refresh'])

    refresh.resolve(json(200, { access_token: 'new-token' }))

    await expect(launch).resolves.toEqual({ token: 'new-token' })
    await expect(pending).resolves.toEqual({ ok: true })
    expect(calledUrls()).toEqual(['/api/auth/refresh', '/api/profile'])
    expect(bearer(fetchMock.mock.calls[1][1] as RequestInit)).toBe('Bearer new-token')
    expect(onRefreshed).toHaveBeenCalledExactlyOnceWith('new-token')
  })

  it('shares the launch refresh with a second caller', async () => {
    const first = refreshSession()
    const second = refreshSession()
    refresh.resolve(json(200, { access_token: 'new-token' }))
    expect(await first).toEqual(await second)
    expect(calledUrls()).toEqual(['/api/auth/refresh'])
  })

  it('fails a held request without sending it when the refresh is refused', async () => {
    const launch = refreshSession()
    const pending = api.get('/profile')
    refresh.resolve(json(401))

    await expect(launch).resolves.toEqual({ error: 'unauthorized' })
    await expect(pending).rejects.toThrow('Unauthorized')
    expect(calledUrls()).toEqual(['/api/auth/refresh'])
    // The launch refresh's caller (AuthProvider) logs out, not each held request
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('fails a held request without sending it when the server could not be reached', async () => {
    const launch = refreshSession()
    const pending = api.get('/profile')
    refresh.resolve(json(503))

    await expect(launch).resolves.toEqual({ error: 'unavailable' })
    await expect(pending).rejects.toThrow('Could not renew the session')
    expect(calledUrls()).toEqual(['/api/auth/refresh'])
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('gets a token before sending a request made without one (no refresh in flight)', async () => {
    const pending = api.get('/profile')
    refresh.resolve(json(200, { access_token: 'new-token' }))

    await expect(pending).resolves.toEqual({ ok: true })
    expect(calledUrls()).toEqual(['/api/auth/refresh', '/api/profile'])
  })

  it('logs out when its own refresh is refused', async () => {
    const pending = api.get('/profile')
    refresh.resolve(json(401))

    await expect(pending).rejects.toThrow('Unauthorized')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(calledUrls()).toEqual(['/api/auth/refresh'])
  })

  it('treats a 403 from the refresh as unreachable, not as a logout', async () => {
    const launch = refreshSession()
    refresh.resolve(json(403))
    await expect(launch).resolves.toEqual({ error: 'unavailable' })
  })

  it("never re-sends a request with another account's token", async () => {
    // The refresh comes back for another account; AuthProvider then ends the old session
    onRefreshed.mockImplementation(() => {
      setToken(null)
      setToken('new-token')
    })
    const launch = refreshSession()
    const pending = api.post('/sessions/strength', { exercises: [] })
    refresh.resolve(json(200, { access_token: 'new-token' }))

    await launch
    await expect(pending).rejects.toThrow('Unauthorized')
    expect(calledUrls()).toEqual(['/api/auth/refresh'])
  })

  it('drops the answer of a request whose session ended while it was in flight', async () => {
    setToken('new-token')
    let answer!: (r: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (answer = r)))
    const pending = api.get('/exercises')
    await new Promise((r) => setTimeout(r, 0))

    setToken(null) // logout
    answer(json(200, [{ id: 1 }]))

    await expect(pending).rejects.toThrow('Unauthorized')
  })

  it("doesn't join a refresh started for a session that has since ended", async () => {
    setToken('old-token')
    const stale = refreshSession()
    setToken(null) // logout
    const pending = api.get('/profile') // the next session's first request
    await new Promise((r) => setTimeout(r, 0))
    expect(calledUrls()).toEqual(['/api/auth/refresh', '/api/auth/refresh'])

    refresh.resolve(json(200, { access_token: 'new-token' }))

    await expect(stale).resolves.toEqual({ error: 'unauthorized' })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('starts no refresh after a logout until the next login', async () => {
    blockRefresh()
    await expect(refreshSession()).resolves.toEqual({ error: 'unauthorized' })
    expect(fetchMock).not.toHaveBeenCalled()

    setToken('login-token')
    const next = refreshSession()
    refresh.resolve(json(200, { access_token: 'new-token' }))
    await expect(next).resolves.toEqual({ token: 'new-token' })
  })

  it('gives no access token when the session changed account while refreshing', async () => {
    onRefreshed.mockImplementation(() => {
      setToken(null)
      setToken('new-token')
    })
    const token = getAccessToken()
    refresh.resolve(json(200, { access_token: 'new-token' }))
    await expect(token).resolves.toBeNull()
  })

  it('waits for the refresh in flight before settling (logout)', async () => {
    const launch = refreshSession()
    let settled = false
    const settle = settleRefresh().then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)

    refresh.resolve(json(200, { access_token: 'new-token' }))
    await launch
    await settle
    expect(settled).toBe(true)
  })

  it('never holds /auth/ requests', async () => {
    refreshSession()
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/refresh' ? refresh.promise : json(200, { access_token: 'login-token' }),
    )

    await expect(api.post('/auth/login', { username: 'a', password: 'b' })).resolves.toEqual({
      access_token: 'login-token',
    })
    expect(calledUrls()).toEqual(['/api/auth/refresh', '/api/auth/login'])
  })

  it('drops a refresh that was in flight when the token was cleared (logout)', async () => {
    setToken('old-token')
    const inFlight = refreshSession()
    setToken(null)
    refresh.resolve(json(200, { access_token: 'new-token' }))

    await expect(inFlight).resolves.toEqual({ error: 'unauthorized' })
    expect(onRefreshed).not.toHaveBeenCalled()
    fetchMock.mockImplementation(async () => json(200, {}))
    await api.post('/auth/login', {})
    expect(bearer(fetchMock.mock.calls.at(-1)![1] as RequestInit)).toBeUndefined()
  })
})

describe('session RPE scale header', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => json(200, { id: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    setToken('token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is sent on every request, so the API accepts a session rpe', async () => {
    await api.post('/sessions/strength', { rpe: 8 })
    await api.patch('/sessions/1', { rpe: 2 })
    await api.get('/sessions')
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)['X-Session-Rpe-Scale']).toBe('10')
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
