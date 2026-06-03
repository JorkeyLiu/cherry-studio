/**
 * Phase 0 — ChangeQueue unit tests
 *
 * Uses an in-memory QueueStore mock so tests don't require IndexedDB.
 */

import type { SyncQueueEntry } from '@renderer/databases'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChangeQueue, type QueueStore } from '../ChangeQueue'
import type { SyncChange, SyncTableName } from '../types'

// ── Helpers ─────────────────────────────────────────────────────

function createChange(overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    id: '',
    table: 'topics' as SyncTableName,
    op: 'CREATE',
    key: 'topic-1',
    newValue: { name: 'test' },
    deviceId: 'device-a',
    timestamp: 0,
    synced: false,
    vector: {},
    ...overrides
  }
}

function createChangeWithTxId(txId: string, key: string, overrides: Partial<SyncChange> = {}): SyncChange {
  return createChange({ txId, key, ...overrides })
}

function createQueueStore(entries: SyncQueueEntry[] = []): QueueStore {
  const store = new Map<string, SyncQueueEntry>()
  for (const e of entries) {
    store.set(e.id, { ...e })
  }

  let idCounter = 0
  const nextId = (): string => {
    idCounter++
    return `mock-id-${idCounter}`
  }

  return {
    add: async (entry) => {
      const id = entry.id || nextId()
      store.set(id, { ...entry, id })
      return id
    },

    update: async (id, changes) => {
      const existing = store.get(id)
      if (!existing) return 0
      store.set(id, { ...existing, ...changes })
      return 1
    },

    bulkDelete: async (ids) => {
      for (const id of ids) {
        store.delete(id)
      }
    },

    where: (index) => ({
      equals(value) {
        const matching = Array.from(store.values()).filter((e) => (e as any)[index] === value)
        return {
          sortBy: async (sortKey) => {
            return [...matching].sort((a, b) => (a as any)[sortKey] - (b as any)[sortKey])
          },
          count: async () => matching.length,
          delete: async () => {
            for (const e of matching) {
              store.delete(e.id)
            }
            return matching.length
          },
          modify: async (callback) => {
            for (const e of matching) {
              callback(e)
            }
          }
        }
      }
    })
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe('ChangeQueue', () => {
  let queue: ChangeQueue
  let store: QueueStore

  beforeEach(() => {
    store = createQueueStore()
    queue = new ChangeQueue(store)
  })

  describe('enqueue / dequeue', () => {
    it('should enqueue a change and return it via dequeue', async () => {
      const change = createChange({ key: 'topic-1', op: 'CREATE' })
      const id = await queue.enqueue(change)
      expect(id).toBeTruthy()

      const pending = await queue.dequeue(10)
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe(id)
      expect(pending[0].table).toBe('topics')
      expect(pending[0].op).toBe('CREATE')
      expect(pending[0].key).toBe('topic-1')
      expect(pending[0].synced).toBe(false)
    })

    it('should not return synced changes', async () => {
      const change = createChange({ key: 'topic-1' })
      const id = await queue.enqueue(change)
      await queue.markSynced([id])

      const pending = await queue.dequeue(10)
      expect(pending).toHaveLength(0)
    })

    it('should return only up to the requested count', async () => {
      for (let i = 0; i < 5; i++) {
        await queue.enqueue(createChange({ key: `topic-${i}` }))
      }
      const pending = await queue.dequeue(3)
      expect(pending).toHaveLength(3)
    })
  })

  describe('markSynced', () => {
    it('should mark changes as synced and remove from debounce map', async () => {
      const id1 = await queue.enqueue(createChange({ key: 'k1' }))
      const id2 = await queue.enqueue(createChange({ key: 'k2' }))

      expect(await queue.getPendingCount()).toBe(2)

      await queue.markSynced([id1])
      expect(await queue.getPendingCount()).toBe(1)

      await queue.markSynced([id2])
      expect(await queue.getPendingCount()).toBe(0)
    })

    it('should be a no-op for an empty list', async () => {
      await expect(queue.markSynced([])).resolves.toBeUndefined()
    })
  })

  describe('getPendingCount', () => {
    it('should return 0 for an empty queue', async () => {
      expect(await queue.getPendingCount()).toBe(0)
    })

    it('should return the correct count of unsynced entries', async () => {
      await queue.enqueue(createChange({ key: 'a' }))
      await queue.enqueue(createChange({ key: 'b' }))
      await queue.enqueue(createChange({ key: 'c' }))
      expect(await queue.getPendingCount()).toBe(3)
    })
  })

  describe('debounce', () => {
    it('should merge successive changes to the same (table, key) within the window', async () => {
      // Enqueue first change
      const id1 = await queue.enqueue(createChange({ table: 'topics', key: 'topic-1', newValue: { name: 'v1' } }))

      // Immediately enqueue another change to the same key (within 200ms)
      const id2 = await queue.enqueue(createChange({ table: 'topics', key: 'topic-1', newValue: { name: 'v2' } }))

      // Should have the same id (debounced/merged)
      expect(id2).toBe(id1)

      const pending = await queue.dequeue(10)
      expect(pending).toHaveLength(1)
      expect(pending[0].newValue).toEqual({ name: 'v2' })
    })

    it('should NOT merge changes to different keys', async () => {
      await queue.enqueue(createChange({ table: 'topics', key: 'topic-1' }))
      await queue.enqueue(createChange({ table: 'topics', key: 'topic-2' }))

      expect(await queue.getPendingCount()).toBe(2)
    })

    it('should NOT merge changes after the debounce window expires', async () => {
      const spy = vi.spyOn(Date, 'now')
      spy.mockReturnValue(1000)

      const id1 = await queue.enqueue(createChange({ table: 'topics', key: 'topic-1', newValue: { name: 'v1' } }))

      // Advance time past the debounce window
      spy.mockReturnValue(1300)

      const id2 = await queue.enqueue(createChange({ table: 'topics', key: 'topic-1', newValue: { name: 'v2' } }))

      expect(id2).not.toBe(id1)
      expect(await queue.getPendingCount()).toBe(2)

      spy.mockRestore()
    })
  })

  describe('batching', () => {
    it('should keep same-txId changes grouped during dequeue', async () => {
      // Enqueue 4 changes: 2 with txId 'tx-1', then 2 with txId 'tx-2'
      const change1 = createChangeWithTxId('tx-1', 'k1', { newValue: { idx: 1 } })
      const change2 = createChangeWithTxId('tx-1', 'k2', { newValue: { idx: 2 } })
      const change3 = createChangeWithTxId('tx-2', 'k3', { newValue: { idx: 3 } })
      const change4 = createChangeWithTxId('tx-2', 'k4', { newValue: { idx: 4 } })

      await queue.enqueue(change1)
      await queue.enqueue(change2)
      await queue.enqueue(change3)
      await queue.enqueue(change4)

      // Dequeue 1 — should get all of tx-1 (2 items) since tx-1 spans the boundary
      const batch1 = await queue.dequeue(1)
      expect(batch1).toHaveLength(2)
      expect(batch1.every((c) => c.txId === 'tx-1')).toBe(true)
    })
  })

  describe('clear', () => {
    it('should remove synced entries older than 24h', async () => {
      // Insert a synced entry with an old timestamp directly into the store,
      // since enqueue() always stamps Date.now().
      const oldTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days ago
      const oldId = 'old-stale-entry'
      await store.add({
        id: oldId,
        table: 'topics',
        op: 'CREATE',
        key: 'old-key',
        deviceId: 'device-a',
        timestamp: oldTimestamp,
        synced: 1,
        vector: {}
      })

      const removed = await queue.clear()
      expect(removed).toBe(1)
    })

    it('should NOT remove recent synced entries', async () => {
      await queue.enqueue(createChange({ key: 'recent' }))
      const changes = await queue.dequeue(10)
      await queue.markSynced(changes.map((c) => c.id))

      const removed = await queue.clear()
      expect(removed).toBe(0)
    })
  })

  describe('clearAll', () => {
    it('should remove all entries regardless of synced state', async () => {
      await queue.enqueue(createChange({ key: 'a' }))
      await queue.enqueue(createChange({ key: 'b' }))

      // Mark one as synced
      const changes = await queue.dequeue(1)
      await queue.markSynced(changes.map((c) => c.id))

      await queue.clearAll()
      expect(await queue.getPendingCount()).toBe(0)
    })
  })
})
