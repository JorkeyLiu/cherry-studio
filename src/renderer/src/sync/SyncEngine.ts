/**
 * Phase 3 — Push / pull orchestration
 *
 * The sync engine ties together the ChangeQueue, ConflictResolver,
 * SyncMeta, and a transport to provide a complete sync cycle:
 *
 *   1. Collect pending changes from ChangeQueue.
 *   2. Push to remote via the active transport.
 *   3. Pull remote changes since lastSyncSeq.
 *   4. Apply remote changes to local Dexie tables.
 *   5. Resolve conflicts via ConflictResolver.
 *   6. Update SyncMeta (seq, timestamp).
 *   7. Emit SyncEngineEvents.
 */

import { loggerService } from '@logger'
import db from '@renderer/databases'

import { getChangeQueue, setSkipSyncCollection } from './ChangeCollector'
import { ConflictResolver } from './ConflictResolver'
import { getDeviceId, getLastSyncSeq, setLastSyncSeq, touchLastSyncTimestamp } from './SyncMeta'
import type { SyncChange, SyncEngineEvents, SyncState, SyncTransport } from './types'

const logger = loggerService.withContext('SyncEngine')

/** Interval between automatic sync cycles (ms) */
const AUTO_SYNC_INTERVAL = 30_000 // 30 seconds

export class SyncEngine {
  private transport: SyncTransport
  private resolver: ConflictResolver
  private state: SyncState = 'idle'
  private events: Partial<SyncEngineEvents> = {}
  private syncTimer?: ReturnType<typeof setInterval>
  private running = false

  constructor(transport: SyncTransport) {
    this.transport = transport
    this.resolver = new ConflictResolver()
  }

  get currentState(): SyncState {
    return this.state
  }

  on<K extends keyof SyncEngineEvents>(event: K, handler: SyncEngineEvents[K]): void {
    this.events[event] = handler
  }

  /** Start the sync engine: connect transport, begin auto-sync loop. */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.setState('connecting')

    try {
      await this.transport.connect()

      // Listen for remote changes
      this.transport.onRemoteChange((changes) => {
        this.applyRemoteChanges(changes).catch((err) => {
          logger.error('Failed to apply remote changes', err)
          this.events.onError?.(err)
        })
      })

      this.setState('idle')

      // Initial sync
      await this.sync()

      // Start auto-sync timer
      this.syncTimer = setInterval(() => {
        this.sync().catch((err) => {
          logger.error('Auto-sync failed', err)
          this.events.onError?.(err)
        })
      }, AUTO_SYNC_INTERVAL)

      logger.info(`SyncEngine started (auto-sync every ${AUTO_SYNC_INTERVAL / 1000}s)`)
    } catch (err) {
      this.setState('error')
      logger.error('SyncEngine failed to start', err as Error)
      throw err
    }
  }

  /** Stop the sync engine gracefully. */
  async stop(): Promise<void> {
    this.running = false
    clearInterval(this.syncTimer)
    this.transport.disconnect()
    this.setState('disconnected')
    logger.info('SyncEngine stopped')
  }

  /** Run one push + pull cycle. */
  async sync(): Promise<void> {
    if (!this.running || this.state === 'syncing') return
    this.setState('syncing')

    try {
      await this.push()
      await this.pull()
      this.setState('idle')
    } catch (err) {
      this.setState('error')
      this.events.onError?.(err as Error)
    }
  }

  /** Push pending local changes to remote. */
  async push(): Promise<void> {
    const queue = getChangeQueue()
    const pending = await queue.dequeue(100)
    if (pending.length === 0) return

    logger.debug(`Pushing ${pending.length} changes`)
    const result = await this.transport.push(pending)

    if (result.success) {
      await queue.markSynced(result.syncedIds)
      this.events.onSyncComplete?.('push', result.syncedIds.length)

      // Handle conflicts returned by the remote
      for (const conflict of result.conflicts) {
        this.handleConflict(conflict)
      }

      // Clean up old synced entries
      await queue.clear()
    } else {
      logger.warn(`Push failed: ${result.error}`)
    }
  }

  /** Pull remote changes and apply to local DB. */
  async pull(): Promise<void> {
    const lastSeq = await getLastSyncSeq()
    logger.debug(`Pulling since seq ${lastSeq}`)

    const result = await this.transport.pull(lastSeq)
    if (result.changes.length === 0) {
      await setLastSyncSeq(result.newSeq)
      return
    }

    logger.debug(`Received ${result.changes.length} remote changes`)
    await this.applyRemoteChanges(result.changes)
    await setLastSyncSeq(result.newSeq)
    await touchLastSyncTimestamp()

    this.events.onSyncComplete?.('pull', result.changes.length)
  }

  /** Apply remote changes to local Dexie tables. */
  private async applyRemoteChanges(changes: SyncChange[]): Promise<void> {
    // Suppress change collection to prevent ping-pong (re-enqueuing remote
    // changes as new local changes that would be pushed back to remote).
    setSkipSyncCollection(true)
    try {
      await this._applyRemoteChanges(changes)
    } finally {
      setSkipSyncCollection(false)
    }
  }

  /** Inner implementation of applyRemoteChanges (skip flag already set). */
  private async _applyRemoteChanges(changes: SyncChange[]): Promise<void> {
    for (const change of changes) {
      try {
        await this.applyChange(change)
      } catch (err) {
        logger.error(`Failed to apply remote change ${change.table}/${change.key}`, err as Error)
      }
    }
    await touchLastSyncTimestamp()
  }

  /**
   * Build a minimal SyncChange representation of the current local record
   * for conflict resolution.  Falls back to 0 when no timestamp is available
   * (conservative — remote with a real timestamp will win).
   */
  private async toLocalChange(change: SyncChange, localValue: unknown): Promise<SyncChange> {
    const deviceId = await getDeviceId()
    const record = localValue as Record<string, unknown> | undefined
    const ts =
      typeof record?.updatedAt === 'number'
        ? record.updatedAt
        : typeof record?.updatedAt === 'string'
          ? new Date(record.updatedAt).getTime()
          : typeof record?.timestamp === 'number'
            ? record.timestamp
            : typeof record?.timestamp === 'string'
              ? new Date(record.timestamp).getTime()
              : 0

    return {
      id: '',
      table: change.table,
      op: change.op,
      key: change.key,
      newValue: localValue,
      deviceId,
      timestamp: ts,
      synced: false,
      vector: {}
    }
  }

  /** Apply a single change to the local database. */
  private async applyChange(change: SyncChange): Promise<void> {
    const table = db.table(change.table)

    switch (change.op) {
      case 'CREATE': {
        const local = await table.get(change.key)
        if (local) {
          // Remote CREATE but local already exists → LWW conflict resolution
          const localChange = await this.toLocalChange(change, local)
          const resolution = this.resolver.resolve(localChange, change)
          if (resolution.resolution === 'remote') {
            await table.put(change.newValue as any)
          }
          // local or merged → keep existing local record (no-op)
        } else {
          await table.put(change.newValue as any)
        }
        break
      }

      case 'UPDATE': {
        const local = await table.get(change.key)
        if (local) {
          // Remote UPDATE and local exists → use ConflictResolver
          const localChange = await this.toLocalChange(change, local)
          const resolution = this.resolver.resolve(localChange, change)

          if (resolution.resolution === 'remote') {
            // Remote wins — apply remote modifications on top of local
            if (change.newValue) {
              await table.update(change.key, change.newValue as any)
            }
          } else if (resolution.resolution === 'merged' && resolution.mergedValue) {
            // Merged value replaces the full record
            await table.put(resolution.mergedValue as any)
          }
          // 'local' → keep local, no-op
        } else {
          // No local record — for UPDATE, newValue is partial (modifications only)
          if (change.oldValue) {
            // Reconstruct full record from oldValue + modifications
            const merged = { ...(change.oldValue as any), ...(change.newValue as any) }
            await table.put(merged)
          } else if (change.newValue && typeof change.newValue === 'object') {
            const nv = change.newValue as Record<string, unknown>
            // Heuristic: if it has explicit `id` (primary key) or enough fields,
            // it might be a full snapshot rather than partial modifications
            if (nv.id || Object.keys(nv).length >= 3) {
              await table.put(nv)
            } else {
              logger.warn('Skipping partial UPDATE for non-existent record', {
                table: change.table,
                key: change.key
              })
            }
          } else {
            logger.warn('Skipping UPDATE for non-existent record', {
              table: change.table,
              key: change.key
            })
          }
        }
        break
      }

      case 'DELETE': {
        // DELETE always wins unconditionally (the deletedAt restoration
        // special case is handled at the ConflictResolver layer during push).
        await table.delete(change.key)
        break
      }
    }
  }

  /** Handle a conflict detected during push. */
  private handleConflict(conflict: any): void {
    const resolution = this.resolver.resolve(conflict.localChange, conflict.remoteChange)
    this.events.onConflict?.({
      ...conflict,
      resolution
    })
    logger.info(`Conflict resolved for ${conflict.localChange.table}/${conflict.localChange.key}: ${resolution}`)
  }

  private setState(state: SyncState): void {
    this.state = state
    this.events.onStateChange?.(state)
  }
}
