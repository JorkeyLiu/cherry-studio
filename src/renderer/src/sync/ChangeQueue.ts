/**
 * Phase 0 — Persistent change queue
 *
 * Maintains an ordered queue of unsynced changes backed by the Dexie
 * `_sync_queue` table. Supports:
 *   - Debounce: successive changes to the same (table, key) within
 *     200 ms are merged into the pending entry.
 *   - Batching: changes sharing the same `txId` are kept together
 *     during dequeue so downstream consumers can apply them atomically.
 */

import { loggerService } from '@logger'
import db, { type SyncQueueEntry } from '@renderer/databases'
import { v4 as uuidv4 } from 'uuid'

import type { ChangeOp, SyncChange, SyncTableName } from './types'

type IndexableType = string | number | Date

const logger = loggerService.withContext('ChangeQueue')

/** How long (ms) to wait before treating a (table,key) as a new change. */
const DEBOUNCE_WINDOW = 200

/** Remove synced entries older than this. */
const RETENTION_MS = 24 * 60 * 60 * 1000

// ─── Storage abstraction ────────────────────────────────────────

/**
 * Minimal store interface that the queue needs from the persistence
 * layer.  The production implementation delegates to Dexie but tests
 * can provide an in-memory alternative.
 */
export interface QueueStore {
  add(entry: SyncQueueEntry): Promise<string>
  update(id: string, changes: Partial<SyncQueueEntry>): Promise<number>
  bulkDelete(ids: string[]): Promise<void>
  where(index: string): {
    equals(value: IndexableType): {
      sortBy(sortKey: string): Promise<SyncQueueEntry[]>
      count(): Promise<number>
      delete(): Promise<number>
      modify(callback: (obj: SyncQueueEntry) => void): Promise<void>
    }
  }
}

// ─── ChangeQueue ────────────────────────────────────────────────

export class ChangeQueue {
  /** In-memory tracker for debounce: `${table}:${key}` → { timestamp, id }. */
  private debounceMap = new Map<string, { timestamp: number; id: string }>()
  private store: QueueStore

  constructor(store?: QueueStore) {
    this.store = store ?? defaultStore
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Enqueue a change.  If a pending (unsynced) entry for the same
   * (table, key) exists within DEBOUNCE_WINDOW ms the entry is updated
   * in-place; otherwise a new row is inserted.
   *
   * The `id`, `synced`, `timestamp` and `vector` fields on the input
   * are ignored / overwritten by the queue.
   */
  async enqueue(change: SyncChange): Promise<string> {
    const now = Date.now()
    const debounceKey = `${change.table}:${change.key}`
    const existing = this.debounceMap.get(debounceKey)

    if (existing && now - existing.timestamp < DEBOUNCE_WINDOW) {
      // Merge into the existing pending entry
      await this.store.update(existing.id, {
        op: change.op,
        newValue: change.newValue,
        oldValue: change.oldValue,
        timestamp: now
      })
      // Keep the debounce reference fresh
      existing.timestamp = now
      logger.debug(`Merged change for ${debounceKey} into pending entry ${existing.id}`)
      return existing.id
    }

    const id = uuidv4()
    const entry: SyncQueueEntry = {
      id,
      table: change.table,
      op: change.op,
      key: change.key,
      newValue: change.newValue,
      oldValue: change.oldValue,
      txId: change.txId,
      deviceId: change.deviceId,
      timestamp: now,
      synced: 0,
      vector: change.vector ?? {}
    }

    await this.store.add(entry)
    this.debounceMap.set(debounceKey, { timestamp: now, id })

    logger.debug(`Enqueued change ${id} for ${change.table}/${change.key}`)
    return id
  }

  /**
   * Return the next `count` pending (unsynced) changes ordered by
   * timestamp.  Entries sharing a `txId` with the last entry in the
   * batch are appended so the batch is never split.
   */
  async dequeue(count: number = 50): Promise<SyncChange[]> {
    const all = await this.store.where('synced').equals(0).sortBy('timestamp')

    if (all.length === 0) return []

    const selected = all.slice(0, count)
    const last = selected[selected.length - 1]

    // Ensure same-txId entries stay together (batch integrity)
    if (last.txId) {
      const siblings = all.slice(count).filter((e) => e.txId === last.txId)
      selected.push(...siblings)
    }
    // Also check: if the first entries in the full list share a txId
    // that straddles the count boundary, ensure they are included
    if (selected.length > 0 && selected[0].txId) {
      const firstTxId = selected[0].txId
      const prefix = all.filter((e) => e.txId === firstTxId)
      for (const p of prefix) {
        if (!selected.find((s) => s.id === p.id)) {
          selected.unshift(p)
        }
      }
    }

    return selected.map(toSyncChange)
  }

  /** Mark the given change IDs as synced. */
  async markSynced(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    for (const id of ids) {
      await this.store.update(id, { synced: 1 })
    }
    // Remove from debounce map
    for (const [key, val] of this.debounceMap) {
      if (ids.includes(val.id)) {
        this.debounceMap.delete(key)
      }
    }
    logger.debug(`Marked ${ids.length} changes as synced`)
  }

  /** Number of unsynced changes awaiting push. */
  async getPendingCount(): Promise<number> {
    return this.store.where('synced').equals(0).count()
  }

  /**
   * Purge synced entries older than RETENTION_MS.
   * Should be called periodically (e.g. after a successful sync).
   */
  async clear(): Promise<number> {
    const cutoff = Date.now() - RETENTION_MS
    const synced = await this.store.where('synced').equals(1).sortBy('timestamp')
    const stale = synced.filter((e) => e.timestamp < cutoff)
    if (stale.length === 0) return 0

    const staleIds = stale.map((e) => e.id)
    await this.store.bulkDelete(staleIds)
    logger.info(`Cleared ${staleIds.length} stale synced entries`)
    return staleIds.length
  }

  /** Remove all entries (for testing / manual reset). */
  async clearAll(): Promise<void> {
    await this.store.where('synced').equals(0).delete()
    await this.store.where('synced').equals(1).delete()
    this.debounceMap.clear()
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function toSyncChange(entry: SyncQueueEntry): SyncChange {
  return {
    id: entry.id,
    table: entry.table as SyncTableName,
    op: entry.op as ChangeOp,
    key: entry.key,
    newValue: entry.newValue,
    oldValue: entry.oldValue,
    txId: entry.txId,
    deviceId: entry.deviceId,
    timestamp: entry.timestamp,
    synced: entry.synced === 1,
    vector: entry.vector
  }
}

// ── Default store (Dexie-backed) ────────────────────────────────

/** Adapts Dexie Table to the QueueStore interface. */
const defaultStore: QueueStore = {
  add(entry) {
    return db._sync_queue.add(entry as any)
  },

  update(id, changes) {
    return db._sync_queue.update(id, changes)
  },

  bulkDelete(ids) {
    return db._sync_queue.bulkDelete(ids)
  },

  where(index: string) {
    const clause = db._sync_queue.where(index as any)
    return {
      equals(value: IndexableType) {
        const coll = clause.equals(value)
        return {
          sortBy(sortKey: string) {
            return coll.sortBy(sortKey) as Promise<SyncQueueEntry[]>
          },
          count() {
            return coll.count()
          },
          delete() {
            return coll.delete() as unknown as Promise<number>
          },
          modify(callback: (obj: SyncQueueEntry) => void) {
            return coll.modify(callback) as unknown as Promise<void>
          }
        }
      }
    }
  }
}
