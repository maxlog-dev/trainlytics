import { QueryClient, dehydrate } from '@tanstack/react-query'
import type { PersistedClient } from '@tanstack/react-query-persist-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => void store.set(key, value),
  del: async (key: string) => void store.delete(key),
}))

import { CACHE_BUSTER, queryCacheKey, queryPersister, setPersistedCacheOwner } from '../lib/queryPersist'
import { SESSION_HINT_KEY } from '../lib/sessionHint'

function persisted(name: string): PersistedClient {
  const qc = new QueryClient()
  qc.setQueryData(['profile'], { name })
  return { timestamp: Date.now(), buster: CACHE_BUSTER, clientState: dehydrate(qc) }
}

function signedInAs(username: string) {
  localStorage.setItem(SESSION_HINT_KEY, username)
  setPersistedCacheOwner(username)
}

const stored = (username: string) => String(store.get(queryCacheKey(username)) ?? '')

// One file of its own: the persister throttles writes (one a second per account)
describe('query persister', () => {
  beforeEach(() => {
    store.clear()
    localStorage.clear()
  })

  afterEach(() => setPersistedCacheOwner(null))

  it("writes a snapshot to the account that owned the cache when it was taken, never a later owner's entry", async () => {
    signedInAs('alice')
    await queryPersister.persistClient(persisted('Alice 1'))
    expect(stored('alice')).toContain('Alice 1')

    // Throttled: waits for the next slot
    const aliceLater = queryPersister.persistClient(persisted('Alice 2'))
    // Meanwhile the account switches to bob
    signedInAs('bob')
    await queryPersister.persistClient(persisted('Bob 1'))
    await aliceLater

    expect(stored('bob')).toContain('Bob 1')
    expect(stored('bob')).not.toContain('Alice')
    // alice no longer owns the cache: her late snapshot is dropped, not written anywhere
    expect(stored('alice')).toContain('Alice 1')
    expect(stored('alice')).not.toContain('Alice 2')
  })

  it('drops a snapshot whose account stopped owning the cache before it was written', async () => {
    signedInAs('hank')
    // The write itself happens after serializing, a tick later
    const pending = queryPersister.persistClient(persisted('Hank'))
    signedInAs('ivy')
    await pending

    expect([...store.keys()]).toEqual([])
  })

  it('writes nothing once another tab signed out or into another account', async () => {
    store.clear()
    signedInAs('carol')
    localStorage.setItem(SESSION_HINT_KEY, 'dave')
    await queryPersister.persistClient(persisted('Carol'))
    expect([...store.keys()]).toEqual([])
  })

  it('restores only for the current owner', async () => {
    store.set(queryCacheKey('alice'), JSON.stringify(persisted('Alice')))
    store.set(queryCacheKey('bob'), JSON.stringify(persisted('Bob')))

    signedInAs('bob')
    const restored = await queryPersister.restoreClient()
    expect(JSON.stringify(restored)).toContain('Bob')
    expect(JSON.stringify(restored)).not.toContain('Alice')

    setPersistedCacheOwner(null)
    expect(await queryPersister.restoreClient()).toBeUndefined()
  })

  it('removes the entry the restore read, even if the owner changed since', async () => {
    store.set(queryCacheKey('erin'), JSON.stringify(persisted('Erin')))
    store.set(queryCacheKey('frank'), JSON.stringify(persisted('Frank')))
    signedInAs('erin')
    await queryPersister.restoreClient()
    signedInAs('frank')

    await queryPersister.removeClient()

    expect([...store.keys()]).toEqual([queryCacheKey('frank')])
  })

  it('keeps the last good data of a query whose refetch failed, as success', async () => {
    signedInAs('gina')
    const client = persisted('Gina')
    const q = client.clientState.queries[0]
    q.state = { ...q.state, status: 'error', error: new Error('offline'), fetchFailureCount: 3 }

    await queryPersister.persistClient(client)

    const saved = JSON.parse(stored('gina')) as PersistedClient
    expect(saved.clientState.queries[0].state).toMatchObject({
      status: 'success',
      error: null,
      fetchFailureCount: 0,
      data: { name: 'Gina' },
    })
  })
})
