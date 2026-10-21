import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// alice's access token ({"sub":"alice"})
const ALICE_TOKEN = 'x.eyJzdWIiOiJhbGljZSJ9.y'

const handlers = vi.hoisted(() => ({
  unauthorized: null as (() => void) | null,
  refreshed: null as ((token: string) => void) | null,
}))
const idb = vi.hoisted(() => new Map<string, unknown>())

vi.mock('idb-keyval', () => ({
  get: async (key: string) => idb.get(key),
  set: async (key: string, value: unknown) => void idb.set(key, value),
  del: async (key: string) => void idb.delete(key),
}))

vi.mock('../lib/api', () => ({
  api: { post: vi.fn(() => Promise.resolve({})) },
  refreshSession: vi.fn(async () => {
    handlers.refreshed?.(ALICE_TOKEN)
    return { token: ALICE_TOKEN }
  }),
  setToken: vi.fn(),
  settleRefresh: vi.fn(async () => {}),
  blockRefresh: vi.fn(),
  sessionEpoch: () => 0,
  setUnauthorizedHandler: (handler: () => void) => {
    handlers.unauthorized = handler
  },
  setSessionRefreshedHandler: (handler: (token: string) => void) => {
    handlers.refreshed = handler
  },
}))

import { AuthProvider, useAuth } from '../contexts/AuthContext'
import { SESSION_HINT_KEY } from '../lib/sessionHint'

let auth: ReturnType<typeof useAuth> | null = null

function Probe() {
  auth = useAuth()
  return null
}

function renderWithCachedProfile() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['profile'], { display_name: 'Alice', rest_seconds: 90 })
  const onAuthRequired = vi.fn()
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider onAuthRequired={onAuthRequired}>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  )
  return { queryClient, onAuthRequired }
}

describe('AuthProvider logout', () => {
  beforeEach(() => {
    auth = null
    handlers.unauthorized = null
    handlers.refreshed = null
    idb.clear()
    localStorage.clear()
    // alice's session from the last visit, with her persisted cache, and bob's
    // (signed in on this browser before) which isn't hers to touch
    localStorage.setItem(SESSION_HINT_KEY, 'alice')
    idb.set('trainlytics:query-cache:alice', '{"alice":true}')
    idb.set('trainlytics:query-cache:bob', '{"bob":true}')
  })

  it('clears cached queries, the persisted cache and the session hint on logout', async () => {
    const { queryClient, onAuthRequired } = renderWithCachedProfile()
    await waitFor(() => expect(auth?.token).toBe(ALICE_TOKEN))
    expect(auth?.username).toBe('alice')
    expect(queryClient.getQueryData(['profile'])).toBeDefined()

    await act(() => auth!.logout())

    expect(queryClient.getQueryData(['profile'])).toBeUndefined()
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(onAuthRequired).toHaveBeenCalled()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull()
    await waitFor(() => expect(idb.has('trainlytics:query-cache:alice')).toBe(false))
    expect(idb.get('trainlytics:query-cache:bob')).toBe('{"bob":true}')
  })

  it('clears cached queries, the persisted cache and the session hint when a 401 forces logout', async () => {
    const { queryClient, onAuthRequired } = renderWithCachedProfile()
    await waitFor(() => expect(auth?.token).toBe(ALICE_TOKEN))
    expect(queryClient.getQueryData(['profile'])).toBeDefined()

    act(() => handlers.unauthorized!())

    expect(queryClient.getQueryData(['profile'])).toBeUndefined()
    expect(onAuthRequired).toHaveBeenCalled()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull()
    await waitFor(() => expect(idb.has('trainlytics:query-cache:alice')).toBe(false))
    expect(idb.get('trainlytics:query-cache:bob')).toBe('{"bob":true}')
    expect(auth?.username).toBeNull()
  })

  it("keeps a hint another tab wrote for a different account", async () => {
    renderWithCachedProfile()
    await waitFor(() => expect(auth?.token).toBe(ALICE_TOKEN))
    // Another tab logged out and signed in as bob; this tab's session then expires
    localStorage.setItem(SESSION_HINT_KEY, 'bob')

    act(() => handlers.unauthorized!())

    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('bob')
    await waitFor(() => expect(idb.has('trainlytics:query-cache:alice')).toBe(false))
    expect(idb.has('trainlytics:query-cache:bob')).toBe(true)
  })

  it("forgets the cached data when a refresh returns another account's token", async () => {
    const { queryClient, onAuthRequired } = renderWithCachedProfile()
    await waitFor(() => expect(auth?.token).toBe(ALICE_TOKEN))

    // bob signed in from another tab; this tab's next refresh gets his token ({"sub":"bob"})
    const bobToken = 'x.eyJzdWIiOiJib2IifQ.y'
    act(() => handlers.refreshed!(bobToken))

    expect(auth?.username).toBe('bob')
    expect(auth?.token).toBe(bobToken)
    expect(queryClient.getQueryData(['profile'])).toBeUndefined()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe('bob')
    await waitFor(() => expect(idb.has('trainlytics:query-cache:alice')).toBe(false))
    expect(onAuthRequired).not.toHaveBeenCalled()
  })
})
