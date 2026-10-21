/**
 * The query cache persisted to IndexedDB, so a launch shows the last-known
 * data at once and refetches it in the background.
 *
 * One entry per account (`trainlytics:query-cache:<username>`). The persister
 * works for this tab's account (the owner, set by AuthProvider) and only while
 * that account is also the browser's session hint, so a tab left on account A
 * stops once another tab signs out or into B. A snapshot belongs to the
 * account that owned the cache when it was taken (each account has its own
 * throttled writer) and is dropped if that account is no longer the owner by
 * the time it is written. AuthProvider clears the owner before clearing the
 * in-memory cache on logout, expiry or an account switch, so the snapshots
 * that clearing produces belong to nobody, then deletes the leaving account's
 * entry. A restore that finds the owner changed restores nothing.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { Query, QueryClient } from '@tanstack/react-query'
import type {
  PersistedClient,
  Persister,
  PersistQueryClientProviderProps,
} from '@tanstack/react-query-persist-client'
import { del, get, set } from 'idb-keyval'
import { readSessionHint } from './sessionHint'

export const QUERY_CACHE_KEY = 'trainlytics:query-cache'

/** Older persisted caches, and older queries in one, are discarded. The QueryClient's gcTime must be at least this. */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// A stuck IndexedDB open (seen in Safari) must not hold the app on the splash
const RESTORE_TIMEOUT_MS = 2000

/** A new build may change response shapes, so it never restores an older build's cache. */
export const CACHE_BUSTER = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'

export function queryCacheKey(username: string): string {
  return `${QUERY_CACHE_KEY}:${username}`
}

let owner: string | null = null
// The account whose entry the last restore read (null when it read nothing)
let restoredFor: string | null = null

/** The account whose entry this tab restores and saves; null stops both. */
export function setPersistedCacheOwner(username: string | null): void {
  owner = username
}

// Null once another tab has signed out or into a different account
function activeOwner(): string | null {
  return owner !== null && readSessionHint() === owner ? owner : null
}

/** Deletes an account's persisted cache. Never throws (no IndexedDB in private mode or tests). */
export async function removePersistedCache(username: string): Promise<void> {
  try {
    await del(queryCacheKey(username))
  } catch {
    // Nothing was stored
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// One throttled writer per account: a snapshot is queued on its account's
// writer when taken, so a later owner never receives an earlier one's data
const writers = new Map<string, Persister>()

function writerFor(username: string): Persister {
  let writer = writers.get(username)
  if (!writer) {
    const key = queryCacheKey(username)
    writer = createAsyncStoragePersister({
      key,
      storage: {
        getItem: async () => null,
        // Dropped if the account stopped owning the cache while it waited
        setItem: async (_key: string, value: string) => {
          if (activeOwner() === username) await set(key, value)
        },
        removeItem: () => removePersistedCache(username),
      },
    })
    writers.set(username, writer)
  }
  return writer
}

/**
 * A query that failed its last refetch still holds its last good data: keep
 * that, as success, so an unreachable server doesn't empty the next launch.
 */
function keepLastGoodData(client: PersistedClient): PersistedClient {
  const queries = client.clientState.queries.map((q) =>
    q.state.status === 'error'
      ? { ...q, state: { ...q.state, status: 'success' as const, error: null, fetchFailureCount: 0, fetchFailureReason: null } }
      : q,
  )
  return { ...client, clientState: { ...client.clientState, queries } }
}

export const queryPersister: Persister = {
  persistClient(client) {
    const user = activeOwner()
    if (user) return writerFor(user).persistClient(keepLastGoodData(client))
  },
  async restoreClient() {
    const user = activeOwner()
    restoredFor = user
    if (!user) return undefined
    try {
      const value = await withTimeout(get<unknown>(queryCacheKey(user)), RESTORE_TIMEOUT_MS)
      // Signed out (or into another account) while reading: restore nothing
      if (activeOwner() !== user || typeof value !== 'string') return undefined
      const client = JSON.parse(value) as PersistedClient
      // Each query's data ages too, not just the snapshot
      const queries = client.clientState.queries.filter((q) => Date.now() - q.state.dataUpdatedAt < PERSIST_MAX_AGE_MS)
      return { ...client, clientState: { ...client.clientState, queries } }
    } catch {
      return undefined
    }
  },
  // Called by the restore for an expired, busted or unreadable entry
  removeClient() {
    if (restoredFor) return removePersistedCache(restoredFor)
  },
}

/** Persisted: queries with data no older than the max age (the last good data of a failed one too). */
function shouldPersistQuery(query: Query): boolean {
  const { status, data, dataUpdatedAt } = query.state
  if (data === undefined || (status !== 'success' && status !== 'error')) return false
  return Date.now() - dataUpdatedAt < PERSIST_MAX_AGE_MS
}

export const persistOptions: PersistQueryClientProviderProps['persistOptions'] = {
  persister: queryPersister,
  maxAge: PERSIST_MAX_AGE_MS,
  buster: CACHE_BUSTER,
  dehydrateOptions: {
    shouldDehydrateQuery: shouldPersistQuery,
    shouldDehydrateMutation: () => false,
  },
}

/**
 * Runs once the restore has hydrated (PersistQueryClientProvider onSuccess).
 * If the account changed after the restore read its entry, what was hydrated
 * is the previous account's: drop it. Otherwise mark everything stale, so the
 * restored data shows at once but is refetched on first use, also for queries
 * that never go stale on their own (staleTime: Infinity, e.g. last-session
 * defaults), which without persistence were fetched fresh on every launch.
 */
export function finishRestore(queryClient: QueryClient): Promise<void> {
  const user = restoredFor
  restoredFor = null
  if (user !== null && user !== activeOwner()) {
    queryClient.clear()
    return Promise.resolve()
  }
  return queryClient.invalidateQueries({ refetchType: 'none' })
}
