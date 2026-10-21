import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  api,
  blockRefresh,
  refreshSession,
  sessionEpoch,
  setSessionRefreshedHandler,
  setToken,
  settleRefresh,
  setUnauthorizedHandler,
  type RefreshResult,
} from '../lib/api'
import { resetRestLength } from '../lib/restLengthSync'
import { SESSION_HINT_KEY, clearSessionHint, readSessionHint, writeSessionHint } from '../lib/sessionHint'
import { removePersistedCache, setPersistedCacheOwner } from '../lib/queryPersist'

interface AuthState {
  token: string | null
  username: string | null
  /**
   * The launch refresh hasn't settled. With a username (a remembered session)
   * the app renders anyway; without one it shows the boot splash.
   */
  isLoading: boolean
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function parseJwt(t: string): { sub?: string } | null {
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as { sub?: string }
  } catch {
    return null
  }
}

interface AuthProviderProps {
  children: ReactNode
  onAuthRequired: () => void
}

/**
 * Session state. A session hint (lib/sessionHint) from the last visit starts
 * the app optimistically as that account while the launch refresh runs: a
 * refused refresh logs out; an unreachable server keeps the app on its cached
 * data, and the next request tries the refresh again (lib/api).
 */
export function AuthProvider({ children, onAuthRequired }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>(() => ({
    token: null,
    username: readSessionHint(),
    isLoading: true,
  }))
  const queryClient = useQueryClient()
  // The account this tab is signed in as (or restoring), for the handlers below
  const accountRef = useRef(state.username)
  // Whether this browser's storage holds our hint (false: storage unavailable)
  const hintStoredRef = useRef(state.username !== null)
  // Bumped when an account leaves: everything below remounts, so no page keeps
  // the previous account's data on screen or in its own state
  const [accountKey, setAccountKey] = useState(0)

  // Cached queries (in memory and persisted) and the stored rest length belong
  // to the account leaving; the next one on this browser must not see (or
  // upload) them. An unsynced rest pick is lost when the session expires.
  // `otherTab`: the logout happened in another tab, which already cleared the
  // device's shared settings (they may be the next account's by now).
  const forgetAccount = useCallback((otherTab = false) => {
    const leaving = accountRef.current
    accountRef.current = null
    // Ends the session in the api module: requests in flight for it are
    // neither re-sent with a later token nor answered into the cache
    setToken(null)
    // Before clearing, so the saves that clearing triggers belong to nobody
    setPersistedCacheOwner(null)
    resetRestLength(!otherTab)
    queryClient.clear()
    if (leaving) {
      clearSessionHint(leaving)
      void removePersistedCache(leaving)
      setAccountKey((k) => k + 1)
    }
  }, [queryClient])

  const adoptToken = useCallback(
    (token: string, fallbackUsername: string | null = null) => {
      const username = parseJwt(token)?.sub ?? fallbackUsername
      // Another account's session (the cookie was replaced from another tab,
      // or a login over a remembered session): the cache is the previous one's
      if (accountRef.current !== null && accountRef.current !== username) forgetAccount()
      accountRef.current = username
      hintStoredRef.current = username !== null && writeSessionHint(username)
      setPersistedCacheOwner(username)
      setToken(token)
      setState({ token, username, isLoading: false })
    },
    [forgetAccount],
  )

  const signOut = useCallback(
    (otherTab = false) => {
      forgetAccount(otherTab)
      setState({ token: null, username: null, isLoading: false })
      onAuthRequired()
    },
    [onAuthRequired, forgetAccount],
  )

  // The api module logs out on a refused refresh and follows every new token.
  // A layout effect, so they are in place before the launch refresh below starts.
  useLayoutEffect(() => {
    setUnauthorizedHandler(() => signOut())
    setSessionRefreshedHandler((token) => {
      // Another tab logged out or signed in as someone else while this refresh
      // ran (its storage event may not have arrived yet): the cookie may be
      // theirs now, so don't adopt the token or write the hint over theirs
      const account = accountRef.current
      if (account !== null && hintStoredRef.current && readSessionHint() !== account) signOut(true)
      else adoptToken(token)
    })
  }, [signOut, adoptToken])

  const signOutRef = useRef(signOut)
  useLayoutEffect(() => {
    signOutRef.current = signOut
  }, [signOut])

  // Launch refresh from the HttpOnly refresh cookie, started once per mount
  // (the ref survives StrictMode's effect replay). A layout effect, so it is
  // in flight before any page's query runs; requests without a token join it.
  const launchRef = useRef<Promise<RefreshResult> | null>(null)
  useLayoutEffect(() => {
    let active = true
    const launchAccount = accountRef.current
    const launchEpoch = sessionEpoch()
    setPersistedCacheOwner(launchAccount)
    launchRef.current ??= refreshSession()
    void launchRef.current.then((result) => {
      // A token is adopted by the handler above. A logout or login since the
      // launch (which ends its session epoch) makes the result stale: it is no
      // verdict on the session now, and that change already settled the state.
      if (!active || 'token' in result || sessionEpoch() !== launchEpoch) return
      if (result.error === 'unauthorized' && launchAccount !== null) {
        signOutRef.current()
        return
      }
      // No session (the login page follows), or the server unreachable (a
      // remembered session stays in the app on its cached data)
      setState((s) => ({ ...s, isLoading: false }))
    })
    return () => {
      active = false
    }
  }, [])

  // Another tab logged out, or signed in as someone else: this tab's session
  // (and the cache on screen) is the previous account's
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== null && e.key !== SESSION_HINT_KEY) return
      const account = accountRef.current
      if (account !== null && readSessionHint() !== account) signOutRef.current(true)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await api.post<{ access_token: string }>('/auth/login', { username, password })
      adoptToken(data.access_token, username)
    },
    [adoptToken],
  )

  const logout = useCallback(async () => {
    // A refresh answered after the logout would re-set the refresh cookie: let
    // the one in flight finish, and start none until the next login
    await settleRefresh()
    blockRefresh()
    const epoch = sessionEpoch()
    await api.post('/auth/logout').catch(() => {})
    // Signed out meanwhile (another tab, an expired session), maybe into
    // another account since: that session isn't this logout's to end
    if (sessionEpoch() === epoch) signOut()
  }, [signOut])

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      <Fragment key={accountKey}>{children}</Fragment>
    </AuthContext.Provider>
  )
}

// Hook lives with its provider; splitting the file only to satisfy fast refresh isn't worth it.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
