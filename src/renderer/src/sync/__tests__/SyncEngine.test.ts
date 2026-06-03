/**
 * Phase 6 — SyncEngine integration test
 *
 * Tests the full sync flow with a mocked transport and in-memory
 * substitutes for Dexie, ChangeCollector, and SyncMeta.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Shared mutable state for mocks ─────────────────────────────

const mockState = vi.hoisted(() => ({
  pendingChanges: [] as Array<{
    id: string
    table: string
    op: string
    key: string
    newValue?: unknown
    oldValue?: unknown
    txId?: string
    deviceId: string
    timestamp: number
    synced: boolean
    vector: Record<string, number>
  }>,
  dbStore: new Map<string, unknown>(),
  lastSyncSeq: 0
}))

// ── Module-level mocks (hoisted by Vitest) ─────────────────────
//
// IMPORTANT: vi.mock() paths are resolved relative to the test file.
// SyncEngine.ts imports from './ChangeCollector' and './SyncMeta'
// which are in the parent directory, so we use '../ChangeCollector'
// and '../SyncMeta' here.

vi.mock('@renderer/databases', () => ({
  default: {
    table: vi.fn().mockImplementation((tableName: string) => ({
      get: vi
        .fn()
        .mockImplementation((key: string) => Promise.resolve(mockState.dbStore.get(`${tableName}:${key}`) ?? null)),
      put: vi.fn().mockImplementation((value: Record<string, unknown>) => {
        const key = String((value as any)?.id ?? 'unknown')
        mockState.dbStore.set(`${tableName}:${key}`, value)
        return Promise.resolve()
      }),
      update: vi.fn().mockImplementation((key: string, changes: Record<string, unknown>) => {
        const existing = mockState.dbStore.get(`${tableName}:${key}`) as Record<string, unknown> | undefined
        if (existing) {
          mockState.dbStore.set(`${tableName}:${key}`, { ...existing, ...changes })
        }
        return Promise.resolve(1)
      }),
      delete: vi.fn().mockImplementation((key: string) => {
        mockState.dbStore.delete(`${tableName}:${key}`)
        return Promise.resolve()
      })
    })),
    // Direct table access used by SyncMeta.ts
    settings: {
      get: vi
        .fn()
        .mockImplementation((key: string) => Promise.resolve(mockState.dbStore.get(`settings:${key}`) ?? null)),
      put: vi.fn().mockImplementation((item: { id: string; value: unknown }) => {
        mockState.dbStore.set(`settings:${item.id}`, item)
        return Promise.resolve()
      }),
      delete: vi.fn().mockImplementation((key: string) => {
        mockState.dbStore.delete(`settings:${key}`)
        return Promise.resolve()
      })
    }
  }
}))

vi.mock('../ChangeCollector', () => ({
  getChangeQueue: vi.fn().mockImplementation(() => ({
    dequeue: vi.fn().mockImplementation((count: number) => {
      const batch = mockState.pendingChanges.splice(0, count)
      return Promise.resolve(batch)
    }),
    markSynced: vi.fn().mockResolvedValue(undefined),
    getPendingCount: vi.fn().mockImplementation(() => Promise.resolve(mockState.pendingChanges.length)),
    clear: vi.fn().mockResolvedValue(0),
    clearAll: vi.fn().mockResolvedValue(undefined)
  })),
  setSkipSyncCollection: vi.fn(),
  isSkipSyncCollection: vi.fn().mockReturnValue(false)
}))

vi.mock('../SyncMeta', () => ({
  getLastSyncSeq: vi.fn().mockImplementation(() => Promise.resolve(mockState.lastSyncSeq)),
  setLastSyncSeq: vi.fn().mockImplementation((seq: number) => {
    mockState.lastSyncSeq = seq
    return Promise.resolve()
  }),
  touchLastSyncTimestamp: vi.fn().mockResolvedValue(undefined),
  getDeviceId: vi.fn().mockResolvedValue('test-device'),
  getLastSyncTimestamp: vi.fn().mockResolvedValue(Date.now()),
  peekDeviceId: vi.fn().mockResolvedValue('test-device'),
  resetSyncMeta: vi.fn().mockResolvedValue(undefined)
}))

// ── Imports (after mocks are installed) ────────────────────────

import { SyncEngine } from '../SyncEngine'
import type { PullResult, PushResult, SyncChange, SyncTransport } from '../types'

// ── MockTransport ──────────────────────────────────────────────

class MockTransport implements SyncTransport {
  stored: SyncChange[] = []
  private callback?: (changes: SyncChange[]) => void
  private _isConnected = false
  connectError?: Error
  pushError?: Error

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError
    this._isConnected = true
  }

  disconnect(): void {
    this._isConnected = false
    this.callback = undefined
  }

  async push(changes: SyncChange[]): Promise<PushResult> {
    if (this.pushError) throw this.pushError
    this.stored.push(...changes.map((c) => ({ ...c })))
    return {
      success: true,
      syncedIds: changes.map((c) => c.id),
      conflicts: []
    }
  }

  async pull(_since: number): Promise<PullResult> {
    return {
      changes: [...this.stored],
      newSeq: this.stored.length
    }
  }

  onRemoteChange(callback: (changes: SyncChange[]) => void): void {
    this.callback = callback
  }

  simulateRemoteChange(changes: SyncChange[]): void {
    this.callback?.(changes)
  }

  reset(): void {
    this.stored = []
    this._isConnected = false
    this.callback = undefined
    this.connectError = undefined
    this.pushError = undefined
  }
}

// ── Helpers ────────────────────────────────────────────────────

function makeChange(overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    id: `ch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    table: 'topics',
    op: 'CREATE',
    key: `key-${Date.now()}`,
    newValue: { title: 'test' },
    deviceId: 'test-device',
    timestamp: Date.now(),
    synced: false,
    vector: {},
    ...overrides
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe('SyncEngine', () => {
  let transport: MockTransport
  let engine: SyncEngine

  beforeEach(() => {
    transport = new MockTransport()
    engine = new SyncEngine(transport)
    mockState.pendingChanges = []
    mockState.dbStore = new Map()
    mockState.lastSyncSeq = 0
  })

  describe('start / stop', () => {
    it('should start, connect transport, and reach idle state', async () => {
      const states: string[] = []
      engine.on('onStateChange', (s) => states.push(s))

      await engine.start()

      expect(transport.isConnected).toBe(true)
      expect(engine.currentState).toBe('idle')
      expect(states).toContain('connecting')
      expect(states).toContain('idle')
    })

    it('should stop cleanly and disconnect transport', async () => {
      await engine.start()
      expect(transport.isConnected).toBe(true)

      await engine.stop()

      expect(engine.currentState).toBe('disconnected')
      expect(transport.isConnected).toBe(false)
    })

    it('should ignore duplicate start calls', async () => {
      await engine.start()
      const spy = vi.spyOn(transport, 'connect')

      await engine.start() // second call is a no-op

      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('push', () => {
    it('should send pending changes to transport and mark them synced', async () => {
      await engine.start()

      const change = makeChange({ id: 'push-1', key: 'topic-push-1' })
      mockState.pendingChanges.push(change)

      await engine.push()

      expect(transport.stored).toHaveLength(1)
      expect(transport.stored[0].id).toBe('push-1')
      expect(transport.stored[0].key).toBe('topic-push-1')
      expect(mockState.pendingChanges).toHaveLength(0)
    })

    it('should handle empty queue gracefully', async () => {
      await engine.start()
      await engine.push()
      expect(transport.stored).toHaveLength(0)
    })

    it('should send multiple pending changes', async () => {
      await engine.start()

      mockState.pendingChanges.push(
        makeChange({ id: 'm1', key: 'k1' }),
        makeChange({ id: 'm2', key: 'k2' }),
        makeChange({ id: 'm3', key: 'k3' })
      )

      await engine.push()

      expect(transport.stored).toHaveLength(3)
    })
  })

  describe('pull', () => {
    it('should apply remote changes to local DB', async () => {
      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'remote-1',
          table: 'topics',
          op: 'CREATE',
          key: 'remote-topic-1',
          newValue: { id: 'remote-topic-1', title: 'Remote Topic' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:remote-topic-1') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect((stored as any).title).toBe('Remote Topic')
    })

    it('should apply CREATE and UPDATE operations', async () => {
      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'r1',
          table: 'topics',
          op: 'CREATE',
          key: 'k1',
          newValue: { id: 'k1', title: 'v1' }
        }),
        makeChange({
          id: 'r2',
          table: 'topics',
          op: 'UPDATE',
          key: 'k1',
          newValue: { id: 'k1', title: 'v2' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:k1') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('v2')
    })

    it('should apply DELETE operations', async () => {
      mockState.dbStore.set('topics:del-key', { id: 'del-key', title: 'to-delete' })

      await engine.start()

      transport.stored.push(makeChange({ id: 'r-del', table: 'topics', op: 'DELETE', key: 'del-key' }))
      mockState.lastSyncSeq = 0

      await engine.pull()

      expect(mockState.dbStore.has('topics:del-key')).toBe(false)
    })

    it('should update lastSyncSeq after a successful pull', async () => {
      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'seq-change',
          key: 'seq-key',
          newValue: { id: 'seq-key' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      expect(mockState.lastSyncSeq).toBe(1)
    })
  })

  describe('sync cycle', () => {
    it('should push local changes and pull remote changes in one cycle', async () => {
      await engine.start()

      // Local pending changes
      mockState.pendingChanges.push(makeChange({ id: 'local-1', key: 'local-key', newValue: { title: 'local' } }))
      // Remote changes (simulates changes from other devices)
      transport.stored.push(
        makeChange({
          id: 'remote-1',
          table: 'topics',
          op: 'CREATE',
          key: 'remote-key',
          newValue: { id: 'remote-key', title: 'remote' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.sync()

      // Local change was pushed to transport
      expect(transport.stored.find((c) => c.id === 'local-1')).toBeDefined()
      // Remote change was applied to local DB
      const storedRemote = mockState.dbStore.get('topics:remote-key') as Record<string, unknown> | undefined
      expect(storedRemote).toBeDefined()
      expect(storedRemote!.title).toBe('remote')
    })

    it('should be a no-op when there are no pending or remote changes', async () => {
      await engine.start()
      const prevSeq = mockState.lastSyncSeq

      await engine.sync()

      expect(mockState.lastSyncSeq).toBe(prevSeq)
    })
  })

  describe('events', () => {
    it('should emit state change events', async () => {
      const states: string[] = []
      engine.on('onStateChange', (s) => states.push(s))

      await engine.start()

      expect(states).toContain('connecting')
      expect(states).toContain('idle')
    })

    it('should emit onError when sync fails', async () => {
      transport.pushError = new Error('Network error')
      const onError = vi.fn()
      engine.on('onError', onError)

      await engine.start()
      // After start the initial sync succeeded (no pending changes).
      // Now add a pending change so the next sync actually pushes.
      mockState.pendingChanges.push(makeChange({ id: 'err-ch' }))
      await engine.sync()

      // sync catches the error and calls onError
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Network error' }))
    })

    it('should emit onSyncComplete after successful push and pull', async () => {
      const syncEvents: Array<{ direction: string; count: number }> = []
      engine.on('onSyncComplete', (direction, count) => syncEvents.push({ direction, count }))

      await engine.start()

      mockState.pendingChanges.push(makeChange({ id: 'sc1', key: 'sk1' }))
      transport.stored.push(
        makeChange({
          id: 'sc2',
          key: 'sk2',
          newValue: { id: 'sk2' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.sync()

      const pushEvent = syncEvents.find((e) => e.direction === 'push')
      const pullEvent = syncEvents.find((e) => e.direction === 'pull')
      expect(pushEvent).toBeDefined()
      expect(pushEvent!.count).toBe(1)
      expect(pullEvent).toBeDefined()
      // Pull receives 2 changes: the pre-existing sc2 + the just-pushed sc1
      expect(pullEvent!.count).toBe(2)
    })

    it('should emit onConflict when remote reports conflicts', async () => {
      await engine.start()

      // Override push to return conflicts
      const origPush = transport.push.bind(transport)
      transport.push = async (changes) => {
        const base = await origPush(changes)
        return {
          ...base,
          conflicts: [
            {
              localChange: changes[0],
              remoteChange: { ...changes[0], id: 'remote-version', timestamp: changes[0].timestamp + 1 },
              resolution: 'remote' as const
            }
          ]
        }
      }

      const onConflict = vi.fn()
      engine.on('onConflict', onConflict)

      mockState.pendingChanges.push(makeChange({ id: 'conf-ch', key: 'conf-key' }))
      await engine.sync()

      expect(onConflict).toHaveBeenCalled()
      expect(onConflict.mock.calls[0][0]).toHaveProperty('resolution')
    })
  })

  describe('auto-sync', () => {
    it('should run sync at the configured interval', async () => {
      vi.useFakeTimers()

      const transport = new MockTransport()
      const engine = new SyncEngine(transport)
      const syncSpy = vi.spyOn(engine, 'sync')

      await engine.start()
      // Initial sync runs during start
      expect(syncSpy).toHaveBeenCalledTimes(1)

      // Advance past the 30 s auto-sync interval
      await vi.advanceTimersByTimeAsync(30_000)

      expect(syncSpy).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      await engine.stop()
    })

    it('should stop auto-sync timer when engine is stopped', async () => {
      vi.useFakeTimers()

      const transport = new MockTransport()
      const engine = new SyncEngine(transport)
      const syncSpy = vi.spyOn(engine, 'sync')

      await engine.start()
      expect(syncSpy).toHaveBeenCalledTimes(1)

      await engine.stop()

      // Advance well past the interval — sync should not fire again
      await vi.advanceTimersByTimeAsync(60_000)
      expect(syncSpy).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })
  })

  describe('remote change listener', () => {
    it('should apply remote changes received via onRemoteChange callback', async () => {
      await engine.start()

      transport.simulateRemoteChange([
        makeChange({
          id: 'live-change',
          table: 'topics',
          op: 'CREATE',
          key: 'live-key',
          newValue: { id: 'live-key', title: 'Live Remote' }
        })
      ])

      // Give the async callback time to process
      await vi.waitFor(() => {
        const stored = mockState.dbStore.get('topics:live-key') as Record<string, unknown> | undefined
        expect(stored).toBeDefined()
        expect(stored!.title).toBe('Live Remote')
      })
    })
  })

  describe('skip sync collection (ping-pong prevention)', () => {
    it('should call setSkipSyncCollection(true) before applying remote changes and (false) after', async () => {
      // Import the mocked setSkipSyncCollection
      const { setSkipSyncCollection } = await import('../ChangeCollector')
      const mockSetSkipSyncCollection = setSkipSyncCollection as ReturnType<typeof vi.fn>
      mockSetSkipSyncCollection.mockClear()

      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'sp-test',
          table: 'topics',
          op: 'CREATE',
          key: 'sp-key',
          newValue: { id: 'sp-key', title: 'test' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      // setSkipSyncCollection should be called with true then false
      expect(mockSetSkipSyncCollection).toHaveBeenCalledWith(true)
      expect(mockSetSkipSyncCollection).toHaveBeenCalledWith(false)
      // true must come before false
      const trueCall = mockSetSkipSyncCollection.mock.calls.findIndex((c: unknown[]) => c[0] === true)
      const falseCall = mockSetSkipSyncCollection.mock.calls.findIndex((c: unknown[]) => c[0] === false)
      expect(trueCall).toBeLessThan(falseCall)
    })
  })

  describe('conflict resolution in pull path', () => {
    it('should keep local when local timestamp is newer (UPDATE)', async () => {
      mockState.dbStore.set('topics:conf-k1', { id: 'conf-k1', title: 'local-value', updatedAt: 5000 })

      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'cr1',
          table: 'topics',
          op: 'UPDATE',
          key: 'conf-k1',
          newValue: { title: 'remote-value' },
          timestamp: 1000,
          deviceId: 'remote-device'
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:conf-k1') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('local-value') // local wins because timestamp 5000 > 1000
    })

    it('should apply remote when remote timestamp is newer (UPDATE)', async () => {
      mockState.dbStore.set('topics:conf-k2', { id: 'conf-k2', title: 'local-value', updatedAt: 1000 })

      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'cr2',
          table: 'topics',
          op: 'UPDATE',
          key: 'conf-k2',
          newValue: { title: 'remote-value' },
          timestamp: 5000,
          deviceId: 'remote-device'
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:conf-k2') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('remote-value') // remote wins
    })

    it('should keep local when local is newer (CREATE conflict)', async () => {
      mockState.dbStore.set('topics:conf-k3', { id: 'conf-k3', title: 'local-create', updatedAt: 5000 })

      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'cr3',
          table: 'topics',
          op: 'CREATE',
          key: 'conf-k3',
          newValue: { id: 'conf-k3', title: 'remote-create' },
          timestamp: 1000,
          deviceId: 'remote-device'
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:conf-k3') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('local-create') // local wins
    })

    it('should apply remote when remote is newer (CREATE conflict)', async () => {
      mockState.dbStore.set('topics:conf-k4', { id: 'conf-k4', title: 'local-create', updatedAt: 1000 })

      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'cr4',
          table: 'topics',
          op: 'CREATE',
          key: 'conf-k4',
          newValue: { id: 'conf-k4', title: 'remote-create' },
          timestamp: 5000,
          deviceId: 'remote-device'
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:conf-k4') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('remote-create') // remote wins
    })

    it('should apply DELETE even when local record exists', async () => {
      mockState.dbStore.set('topics:del-existing', { id: 'del-existing', title: 'to-delete' })

      await engine.start()

      transport.stored.push(makeChange({ id: 'del1', table: 'topics', op: 'DELETE', key: 'del-existing' }))
      mockState.lastSyncSeq = 0

      await engine.pull()

      expect(mockState.dbStore.has('topics:del-existing')).toBe(false)
    })

    it('should handle merged resolution for settings table', async () => {
      mockState.dbStore.set('settings:prefs', { id: 'prefs', darkMode: true, updatedAt: 1000 })

      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'merge1',
          table: 'settings',
          op: 'UPDATE',
          key: 'prefs',
          newValue: { fontSize: 14 },
          timestamp: 500,
          deviceId: 'remote-device'
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('settings:prefs') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      // The merged value should contain both fields
      expect(stored!.darkMode).toBe(true)
      expect(stored!.fontSize).toBe(14)
    })
  })

  describe('partial UPDATE for non-existent record', () => {
    it('should reconstruct full record from oldValue + newValue when local does not exist', async () => {
      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'partial1',
          table: 'topics',
          op: 'UPDATE',
          key: 'non-existent',
          newValue: { title: 'updated-title' },
          oldValue: { id: 'non-existent', title: 'old-title', content: 'old-content' }
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:non-existent') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('updated-title')
      expect(stored!.content).toBe('old-content')
    })

    it('should skip partial UPDATE when no oldValue and minimal newValue', async () => {
      // The engine will log a warning but not crash
      await engine.start()

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) // silence expected warning

      transport.stored.push(
        makeChange({
          id: 'partial2',
          table: 'topics',
          op: 'UPDATE',
          key: 'non-existent-2',
          newValue: { title: 'only-title' } // only 1 field, no id
          // no oldValue
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      // Record should NOT have been created
      expect(mockState.dbStore.has('topics:non-existent-2')).toBe(false)

      warnSpy.mockRestore()
    })

    it('should accept partial UPDATE when newValue has explicit id field', async () => {
      await engine.start()

      transport.stored.push(
        makeChange({
          id: 'partial3',
          table: 'topics',
          op: 'UPDATE',
          key: 'non-existent-3',
          newValue: { id: 'non-existent-3', title: 'has-id' }
          // no oldValue
        })
      )
      mockState.lastSyncSeq = 0

      await engine.pull()

      const stored = mockState.dbStore.get('topics:non-existent-3') as Record<string, unknown> | undefined
      expect(stored).toBeDefined()
      expect(stored!.title).toBe('has-id')
    })
  })
})
