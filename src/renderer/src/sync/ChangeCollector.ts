/**
 * Phase 0 — Dexie hook → ChangeQueue bridge
 *
 * Registers `creating`, `updating`, and `deleting` hooks on every
 * sync-enabled Dexie table. Each hook captures the change data
 * synchronously into a pending array and uses `queueMicrotask()` to
 * flush accumulated changes to the async ChangeQueue, respecting
 * Dexie transaction boundaries.
 *
 * === Transaction safety ===
 * Dexie v4 hooks are synchronous but ChangeQueue.enqueue() returns a
 * Promise.  Instead of awaiting inside a hook (which would lose the
 * transaction context), hooks push to a synchronous intermediate
 * array.  A microtask scheduled from the first hook of a batch
 * flushes all pending changes after the current synchronous block
 * completes.
 *
 * A WeakMap<Transaction, string> maps each Dexie Transaction to a
 * stable batchId (UUIDv4), replacing dependency on the internal
 * `_txId` property.
 */

import { loggerService } from '@logger'
import db from '@renderer/databases'

import { ChangeQueue } from './ChangeQueue'
import { getDeviceId } from './SyncMeta'
import type { ChangeOp, SyncChange, SyncTableName } from './types'

const logger = loggerService.withContext('ChangeCollector')

// Singleton queue instance shared across all hooks
let queue: ChangeQueue | null = null
let deviceId: string | null = null

/**
 * Reference counter to suppress change collection during sync writes.
 * Incremented before writing remote changes and decremented after,
 * allowing nested calls (e.g. batch apply) to work correctly without
 * prematurely re-enabling collection. Prevents ping-pong where synced
 * changes would be re-enqueued as new local changes.
 */
let skipSyncCollectionDepth = 0

export function setSkipSyncCollection(value: boolean): void {
  skipSyncCollectionDepth = value ? skipSyncCollectionDepth + 1 : Math.max(0, skipSyncCollectionDepth - 1)
}

export function isSkipSyncCollection(): boolean {
  return skipSyncCollectionDepth > 0
}

/** Tables eligible for cross-device sync */
const SYNC_TABLES: SyncTableName[] = [
  'topics',
  'message_blocks',
  'files',
  'settings',
  'knowledge_notes',
  'translate_history',
  'translate_languages',
  'quick_phrases'
]

/**
 * Initialize the change collector. Call once during app startup
 * AFTER the Dexie database has been opened.
 *
 * Registers `creating`, `updating`, and `deleting` hooks on every
 * sync-enabled table. Each hook captures the change data and pushes
 * it into the ChangeQueue.
 */
export async function initChangeCollector(): Promise<void> {
  // Get or create device identity
  deviceId = await getDeviceId()
  queue = new ChangeQueue()

  // ── Synchronous intermediate queue & transaction tracking ──────
  //
  // Hooks *must not* call async functions directly (Dexie hooks are
  // synchronous).  Instead they append to this array.  The first hook
  // in a synchronous batch schedules a microtask that flushes all
  // accumulated changes to the async ChangeQueue.
  const pendingChanges: SyncChange[] = []

  /**
   * Maps each Dexie Transaction to a stable batch ID (UUIDv4).
   * All hooks firing within the same transaction share the same
   * batchId, replacing the former dependency on the internal
   * `(transaction as any)._txId` property.
   */
  const txBatchMap = new WeakMap<object, string>()

  /** Ensures only one microtask is scheduled per synchronous batch. */
  let flushScheduled = false

  /**
   * Flush all pending changes to the ChangeQueue.
   * Called once per synchronous batch via queueMicrotask.
   */
  function flushPending(): void {
    flushScheduled = false
    if (isSkipSyncCollection()) return // safety net — skip processing entirely
    const batch = pendingChanges.splice(0)
    for (const change of batch) {
      queue!.enqueue(change).catch((err) => {
        logger.error(`Failed to enqueue ${change.op} for ${change.table}/${change.key}`, err)
      })
    }
  }

  /**
   * Get or create a stable batch ID for the given transaction.
   * All hooks in the same transaction share the same batch ID.
   */
  function getBatchId(transaction: object): string {
    let id = txBatchMap.get(transaction)
    if (!id) {
      id = crypto.randomUUID()
      txBatchMap.set(transaction, id)
    }
    return id
  }

  /**
   * Schedule a microtask flush if one isn't already pending.
   * Called by each hook when it pushes its first change of the batch.
   */
  function scheduleFlush(): void {
    if (!flushScheduled) {
      flushScheduled = true
      queueMicrotask(flushPending)
    }
  }

  for (const tableName of SYNC_TABLES) {
    const table = db.table(tableName)

    // CREATE hook
    table.hook('creating', function (primKey, obj, transaction) {
      if (!queue || !deviceId) return
      if (isSkipSyncCollection()) return

      const change: SyncChange = {
        id: '', // ChangeQueue will assign
        table: tableName,
        op: 'CREATE' as ChangeOp,
        key: String(primKey),
        newValue: structuredClone(obj), // Deep copy to avoid mutations
        deviceId,
        timestamp: Date.now(),
        synced: false,
        vector: { [deviceId]: Date.now() },
        txId: getBatchId(transaction)
      }

      pendingChanges.push(change)
      scheduleFlush()
    })

    // UPDATE hook
    table.hook('updating', function (modifications, primKey, oldObj, transaction) {
      if (!queue || !deviceId) return
      if (isSkipSyncCollection()) return

      // Detect deletedAt changes for topics table (soft delete / restore)
      if (tableName === 'topics' && 'deletedAt' in modifications) {
        if (modifications.deletedAt != null) {
          logger.info(`Soft-delete detected for topics/${primKey}: deletedAt=${modifications.deletedAt}`)
        } else {
          logger.info(`Restore detected for topics/${primKey}: deletedAt cleared`)
        }
      }

      const change: SyncChange = {
        id: '',
        table: tableName,
        op: 'UPDATE' as ChangeOp,
        key: String(primKey),
        newValue: structuredClone(modifications),
        oldValue: structuredClone(oldObj),
        deviceId,
        timestamp: Date.now(),
        synced: false,
        vector: { [deviceId]: Date.now() },
        txId: getBatchId(transaction)
      }

      pendingChanges.push(change)
      scheduleFlush()
    })

    // DELETE hook
    table.hook('deleting', function (primKey, oldObj, transaction) {
      if (!queue || !deviceId) return
      if (isSkipSyncCollection()) return

      const change: SyncChange = {
        id: '',
        table: tableName,
        op: 'DELETE' as ChangeOp,
        key: String(primKey),
        oldValue: structuredClone(oldObj),
        deviceId,
        timestamp: Date.now(),
        synced: false,
        vector: { [deviceId]: Date.now() },
        txId: getBatchId(transaction)
      }

      pendingChanges.push(change)
      scheduleFlush()
    })

    logger.debug(`Registered hooks for table: ${tableName}`)
  }

  logger.info(`ChangeCollector initialized for ${SYNC_TABLES.length} tables (device: ${deviceId})`)
}

/**
 * Get the singleton ChangeQueue instance.
 * Throws if initChangeCollector() has not been called yet.
 */
export function getChangeQueue(): ChangeQueue {
  if (!queue) {
    throw new Error('ChangeCollector not initialized. Call initChangeCollector() first.')
  }
  return queue
}
