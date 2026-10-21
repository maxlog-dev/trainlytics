import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, dehydrate, useQuery } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { useCallback } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const idb = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  // Set to hold the next read until the test lets it through
  gate: null as Promise<void> | null,
}))

vi.mock('idb-keyval', () => ({
  // Like IndexedDB: the read sees the entry as it was when it started
  get: async (key: string) => {
    const value = idb.store.get(key)
    if (idb.gate) await idb.gate
    return value
  },
  set: async (key: string, value: unknown) => void idb.store.set(key, value),
  del: async (key: string) => void idb.store.delete(key),
}))

import { AuthProvider } from '../contexts/AuthContext'
import { ProtectedRoute } from '../components/ProtectedRoute'
import { api, refreshSession, setToken } from '../lib/api'
import { SESSION_HINT_KEY } from '../lib/sessionHint'
import {
  CACHE_BUSTER,
  PERSIST_MAX_AGE_MS,
  finishRestore,
  persistOptions,
  queryCacheKey,
  setPersistedCacheOwner,
} from '../lib/queryPersist'

// alice's access token ({"sub":"alice"})
const ALICE = 'x.eyJzdWIiOiJhbGljZSJ9.y'

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A persisted cache holding one profile query, as the persister writes it. */
function persistedProfile(name: string, buster = CACHE_BUSTER): string {
  const qc = new QueryClient()
  qc.setQueryData(['profile'], { name })
  return JSON.stringify({ timestamp: Date.now(), buster, clientState: dehydrate(qc) })
}

let shown: string[] = []

function TodayProbe() {
  const { data, isLoading } = useQuery({ queryKey: ['profile'], queryFn: () => api.get<{ name: string }>('/profile') })
  const text = isLoading ? 'Loading…' : data ? `profile ${data.name}` : 'no profile'
  shown.push(text)
  return <p>{text}</p>
}

function Shell() {
  const navigate = useNavigate()
  const onAuthRequired = useCallback(() => navigate('/login', { replace: true }), [navigate])
  return (
    <AuthProvider onAuthRequired={onAuthRequired}>
      <Routes>
        <Route path="/login" element={<p>Login page</p>} />
        <Route
          path="/today"
          element={
            <ProtectedRoute>
              <TodayProbe />
            </ProtectedRoute>
          }
        />
      </Routes>
    </AuthProvider>
  )
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: PERSIST_MAX_AGE_MS } },
  })
  render(
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      onSuccess={() => finishRestore(queryClient)}
    >
      <MemoryRouter initialEntries={['/today']}>
        <Shell />
      </MemoryRouter>
    </PersistQueryClientProvider>,
  )
  return queryClient
}

const fetchMock = vi.fn()
let resolveRefresh: (r: Response) => void

describe('persisted query cache', () => {
  beforeEach(() => {
    shown = []
    idb.store.clear()
    idb.gate = null
    localStorage.clear()
    setToken(null)
    const refresh = new Promise<Response>((r) => (resolveRefresh = r))
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === '/api/auth/refresh') return refresh
      const auth = (init.headers as Record<string, string>)['Authorization']
      if (auth !== `Bearer ${ALICE}`) return Promise.resolve(json(401))
      return Promise.resolve(json(200, { name: 'Alice (fresh)' }))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    cleanup()
    resolveRefresh(json(401))
    await new Promise((r) => setTimeout(r, 0))
    vi.unstubAllGlobals()
  })

  it("shows the remembered account's last-known data at once, then refetches it", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    idb.store.set(queryCacheKey('alice'), persistedProfile('Alice (cached)'))
    renderApp()

    // Before the launch refresh settles, and as the page's first render (the
    // splash covers the restore, so no empty or loading state shows first)
    expect(await screen.findByText('profile Alice (cached)')).toBeInTheDocument()
    expect(shown[0]).toBe('profile Alice (cached)')

    await act(async () => resolveRefresh(json(200, { access_token: ALICE })))

    expect(await screen.findByText('profile Alice (fresh)')).toBeInTheDocument()
    expect(shown).not.toContain('Loading…')
    // Saved back to alice's own entry, and nowhere else
    await waitFor(() => expect(String(idb.store.get(queryCacheKey('alice')))).toContain('Alice (fresh)'), {
      timeout: 3000,
    })
    expect([...idb.store.keys()]).toEqual([queryCacheKey('alice')])
  })

  it("never saves the previous account's data into the next one's entry", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    const queryClient = renderApp()
    await act(async () => resolveRefresh(json(200, { access_token: ALICE })))
    queryClient.setQueryData(['exercises'], [{ name: 'Alice squat' }])
    expect(await screen.findByText('profile Alice (fresh)')).toBeInTheDocument()
    // Writes are throttled to one a second per account
    await waitFor(() => expect(String(idb.store.get(queryCacheKey('alice')))).toContain('Alice squat'), {
      timeout: 3000,
    })

    // bob signed in from another tab; this tab's next refresh returns his token ({"sub":"bob"})
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/auth/refresh' ? json(200, { access_token: 'x.eyJzdWIiOiJib2IifQ.y' }) : json(401)),
    )
    await act(async () => {
      await refreshSession()
    })
    await new Promise((r) => setTimeout(r, 1100)) // past the persister's write throttle

    expect(queryClient.getQueryData(['exercises'])).toBeUndefined()
    expect(String(idb.store.get(queryCacheKey('bob')) ?? '')).not.toContain('Alice')
    expect(idb.store.has(queryCacheKey('alice'))).toBe(false)
  })

  it("drops what it restored if the account changed after IndexedDB answered", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    idb.store.set(queryCacheKey('alice'), persistedProfile('Alice (cached)'))
    const queryClient = new QueryClient()
    const { persistQueryClientRestore } = await import('@tanstack/react-query-persist-client')
    setPersistedCacheOwner('alice')
    await persistQueryClientRestore({ ...persistOptions, queryClient })
    expect(queryClient.getQueryData(['profile'])).toBeDefined()
    // The account changes between the hydration and the provider's onSuccess
    setPersistedCacheOwner(null)

    await finishRestore(queryClient)

    expect(queryClient.getQueryData(['profile'])).toBeUndefined()
  })

  it("never restores another account's entry", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    idb.store.set(queryCacheKey('bob'), persistedProfile('Bob'))
    renderApp()

    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    await act(async () => resolveRefresh(json(200, { access_token: ALICE })))
    expect(await screen.findByText('profile Alice (fresh)')).toBeInTheDocument()
    expect(shown.some((s) => s.includes('Bob'))).toBe(false)
  })

  it('restores nothing without a session hint', async () => {
    idb.store.set(queryCacheKey('alice'), persistedProfile('Alice (cached)'))
    renderApp()

    await act(async () => resolveRefresh(json(200, { access_token: ALICE })))
    expect(await screen.findByText('profile Alice (fresh)')).toBeInTheDocument()
    expect(shown).not.toContain('profile Alice (cached)')
  })

  it('restores nothing when the session is refused before IndexedDB answers, and deletes the entry', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    idb.store.set(queryCacheKey('alice'), persistedProfile('Alice (cached)'))
    let openGate!: () => void
    idb.gate = new Promise((r) => (openGate = r))
    const queryClient = renderApp()

    await act(async () => resolveRefresh(json(401)))
    expect(await screen.findByText('Login page')).toBeInTheDocument()
    await act(async () => openGate())
    await new Promise((r) => setTimeout(r, 0))

    expect(queryClient.getQueryData(['profile'])).toBeUndefined()
    expect(idb.store.has(queryCacheKey('alice'))).toBe(false)
  })

  it('discards a cache saved by another build', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    idb.store.set(queryCacheKey('alice'), persistedProfile('Alice (old build)', 'old-build'))
    renderApp()

    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    await waitFor(() => expect(idb.store.has(queryCacheKey('alice'))).toBe(false))
    expect(shown).not.toContain('profile Alice (old build)')
  })
})
