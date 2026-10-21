import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

// AuthProvider deletes a persisted cache on logout; jsdom has no IndexedDB
vi.mock('idb-keyval', () => ({ get: async () => undefined, set: async () => {}, del: async () => {} }))

import { AuthProvider, useAuth } from '../contexts/AuthContext'
import { ProtectedRoute } from '../components/ProtectedRoute'
import { api, setToken } from '../lib/api'
import { SESSION_HINT_KEY } from '../lib/sessionHint'

// alice's access token ({"sub":"alice"})
const ALICE = 'x.eyJzdWIiOiJhbGljZSJ9.y'

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function TodayProbe() {
  const { username, isLoading: authLoading, logout } = useAuth()
  const { data } = useQuery({ queryKey: ['profile'], queryFn: () => api.get<{ name: string }>('/profile') })
  return (
    <div>
      <p>Today for {username}</p>
      <p>{authLoading ? 'auth resolving' : 'auth settled'}</p>
      <p>{data ? `profile ${data.name}` : 'no profile yet'}</p>
      <button type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  )
}

function LoginProbe() {
  const { login, username } = useAuth()
  return (
    <div>
      <p>Login page</p>
      <p>{username ? `Signed in as ${username}` : 'Signed out'}</p>
      <button type="button" onClick={() => void login('bob', 'test-password')}>
        Sign in as bob
      </button>
      <button type="button" onClick={() => void login('alice', 'test-password')}>
        Sign in as alice
      </button>
    </div>
  )
}

function Shell() {
  const navigate = useNavigate()
  const onAuthRequired = useCallback(() => navigate('/login', { replace: true }), [navigate])
  return (
    <AuthProvider onAuthRequired={onAuthRequired}>
      <Routes>
        <Route path="/login" element={<LoginProbe />} />
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

function app(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/today']}>
        <Shell />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(app(queryClient))
  return queryClient
}

const fetchMock = vi.fn()
let launchRefresh: ReturnType<typeof deferred<Response>>

function urls(): string[] {
  return fetchMock.mock.calls.map((c) => c[0] as string)
}

function bearer(call: unknown[]): string | undefined {
  return ((call[1] as RequestInit).headers as Record<string, string>)['Authorization']
}

/** Lets the pages' effects run and any request that isn't waiting go out. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

describe('optimistic auth at launch', () => {
  beforeEach(() => {
    localStorage.clear()
    setToken(null)
    launchRefresh = deferred<Response>()
    fetchMock.mockReset()
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === '/api/auth/refresh') return launchRefresh.promise.then((r) => r.clone())
      if (url === '/api/profile') {
        const auth = (init.headers as Record<string, string>)['Authorization']
        return Promise.resolve(auth === `Bearer ${ALICE}` ? json(200, { name: 'Alice' }) : json(401))
      }
      return Promise.resolve(json(404))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    cleanup()
    // Settle a refresh still in flight so the next test starts its own
    launchRefresh.resolve(json(401))
    await new Promise((r) => setTimeout(r, 0))
    vi.unstubAllGlobals()
  })

  it('renders the page at once for a remembered session; its request waits for the launch token', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()

    expect(screen.getByText('Today for alice')).toBeInTheDocument()
    expect(screen.getByText('auth resolving')).toBeInTheDocument()
    expect(document.getElementById('boot-splash')).toBeNull()
    await flush()
    // The page's query waits on the launch refresh instead of going out without a token
    expect(urls()).toEqual(['/api/auth/refresh'])

    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))

    expect(await screen.findByText('profile Alice')).toBeInTheDocument()
    expect(screen.getByText('auth settled')).toBeInTheDocument()
    // One refresh, and the request carried its token (no 401 and retry)
    expect(urls()).toEqual(['/api/auth/refresh', '/api/profile'])
    expect(bearer(fetchMock.mock.calls[1])).toBe(`Bearer ${ALICE}`)
  })

  it('shows the boot splash without a session hint until the refresh settles', async () => {
    renderApp()

    expect(document.getElementById('boot-splash')).not.toBeNull()
    expect(screen.queryByText(/Today for/)).toBeNull()

    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))

    expect(await screen.findByText('Today for alice')).toBeInTheDocument()
    expect(document.getElementById('boot-splash')).toBeNull()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('alice')
    expect(await screen.findByText('profile Alice')).toBeInTheDocument()
    expect(urls().filter((u) => u === '/api/auth/refresh')).toHaveLength(1)
  })

  it('goes to the login page without a hint when there is no session', async () => {
    renderApp()
    await act(async () => launchRefresh.resolve(json(401)))
    expect(await screen.findByText('Login page')).toBeInTheDocument()
  })

  it('logs a remembered session out when the refresh is refused; the waiting request is never sent', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()
    await flush()

    await act(async () => launchRefresh.resolve(json(401)))

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull()
    expect(urls()).toEqual(['/api/auth/refresh'])
  })

  it('keeps a remembered session in the app when the server cannot be reached', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    const queryClient = renderApp()
    queryClient.setQueryData(['profile'], { name: 'Alice (cached)' })
    await flush()

    await act(async () => launchRefresh.reject(new TypeError('Failed to fetch')))
    await flush()

    expect(screen.getByText('Today for alice')).toBeInTheDocument()
    expect(screen.getByText('auth settled')).toBeInTheDocument()
    expect(screen.getByText('profile Alice (cached)')).toBeInTheDocument()
    expect(screen.queryByText('Login page')).toBeNull()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('alice')
  })

  it('sends one launch refresh under StrictMode, even when it answers at once', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    launchRefresh.resolve(json(200, { access_token: ALICE }))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const actEnv = env.IS_REACT_ACT_ENVIRONMENT
    // Outside act(), like the real app: effects (and StrictMode's replay) run on React's own schedule
    env.IS_REACT_ACT_ENVIRONMENT = false
    const root = createRoot(container)
    try {
      root.render(
        <StrictMode>{app(new QueryClient({ defaultOptions: { queries: { retry: false } } }))}</StrictMode>,
      )
      await new Promise((r) => setTimeout(r, 100))
      expect(container.textContent).toContain('profile Alice')
      expect(urls().filter((u) => u === '/api/auth/refresh')).toHaveLength(1)
    } finally {
      root.unmount()
      container.remove()
      env.IS_REACT_ACT_ENVIRONMENT = actEnv
    }
  })

  it('signs out when another tab logs out', async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    const queryClient = renderApp()
    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))
    expect(await screen.findByText('profile Alice')).toBeInTheDocument()

    // The other tab's logout removes the hint; this tab hears it through the storage event
    localStorage.removeItem(SESSION_HINT_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_HINT_KEY, newValue: null }))
    })

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(queryClient.getQueryData(['profile'])).toBeUndefined()
  })

  it("doesn't let a stale launch refresh sign out the account that signed in after it", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()
    await flush()
    // Another tab logs out while this tab's launch refresh is still in flight
    localStorage.removeItem(SESSION_HINT_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_HINT_KEY, newValue: null }))
    })
    expect(await screen.findByText('Login page')).toBeInTheDocument()

    // bob signs in here ({"sub":"bob"})
    const bobToken = 'x.eyJzdWIiOiJib2IifQ.y'
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/refresh' ? launchRefresh.promise : Promise.resolve(json(200, { access_token: bobToken })),
    )
    await act(async () => screen.getByRole('button', { name: 'Sign in as bob' }).click())
    await flush()

    // Then the old launch refresh answers (for alice)
    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))
    await flush()

    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('bob')
    expect(screen.queryByText('Signed out')).toBeNull()
  })

  /** Another tab's logout, as this tab hears it. */
  function otherTabLogsOut() {
    localStorage.removeItem(SESSION_HINT_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SESSION_HINT_KEY, newValue: null }))
    })
  }

  function loginAnswers(token: string) {
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/refresh'
        ? launchRefresh.promise.then((r) => r.clone())
        : Promise.resolve(json(200, { access_token: token })),
    )
  }

  it("doesn't let a stale launch refresh sign out the same account signing in again", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()
    await flush()
    otherTabLogsOut()
    expect(await screen.findByText('Login page')).toBeInTheDocument()

    loginAnswers(ALICE)
    await act(async () => screen.getByRole('button', { name: 'Sign in as alice' }).click())
    await flush()
    // The old launch refresh is refused (the session it was for has ended)
    await act(async () => launchRefresh.resolve(json(401)))
    await flush()

    expect(screen.getByText('Signed in as alice')).toBeInTheDocument()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('alice')
  })

  it("doesn't adopt a refresh over another tab's newer sign-in", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()
    await flush()
    // bob signs in elsewhere; this tab's storage event hasn't been handled yet
    localStorage.setItem(SESSION_HINT_KEY, 'bob')

    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('bob')
  })

  it("doesn't let a logout that finishes late sign out the next account", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()
    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))
    expect(await screen.findByText('profile Alice')).toBeInTheDocument()

    let finishLogout!: (r: Response) => void
    fetchMock.mockImplementation((url: string) =>
      url === '/api/auth/logout' ? new Promise<Response>((r) => (finishLogout = r)) : Promise.resolve(json(401)),
    )
    await act(async () => screen.getByRole('button', { name: 'Sign out' }).click())
    await flush()
    // Meanwhile another tab logs out and bob signs in here
    otherTabLogsOut()
    loginAnswers('x.eyJzdWIiOiJib2IifQ.y')
    await act(async () => screen.getByRole('button', { name: 'Sign in as bob' }).click())
    await flush()

    await act(async () => finishLogout(json(200, {})))
    await flush()

    expect(screen.getByText('Signed in as bob')).toBeInTheDocument()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('bob')
  })

  it("keeps the device's rest length when another tab's logout signs this tab out", async () => {
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    renderApp()
    await act(async () => launchRefresh.resolve(json(200, { access_token: ALICE })))
    // By now another account may have picked a length in the other tab
    localStorage.setItem('trainlytics_rest_seconds', '120')

    otherTabLogsOut()

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(localStorage.getItem('trainlytics_rest_seconds')).toBe('120')
  })
})

describe('login failure', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows a wrong password on the form instead of resetting it', async () => {
    localStorage.clear()
    setToken(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/auth/login' ? json(401, { detail: 'Invalid credentials' }) : json(401),
      ),
    )
    const { default: LoginPage } = await import('../pages/LoginPage')
    function LoginShell() {
      const navigate = useNavigate()
      const onAuthRequired = useCallback(() => navigate('/login', { replace: true }), [navigate])
      return (
        <AuthProvider onAuthRequired={onAuthRequired}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </AuthProvider>
      )
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/login']}>
          <LoginShell />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const user = (await import('@testing-library/user-event')).default.setup()
    await user.type(await screen.findByLabelText('Username'), 'alice')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized')
    expect(screen.getByLabelText('Username')).toHaveValue('alice')
  })
})
