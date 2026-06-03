/**
 * Phase 2 — Conflict resolution strategies
 *
 * Implements per-table conflict resolution policies:
 *   - LWW: Last-Writer-Wins (timestamp + deviceId tiebreaker)
 *   - Merge: Field-level merge for settings (non-destructive)
 *   - Restore-wins: Special handling for topics.deletedAt
 */

import { loggerService } from '@logger'

import type { SyncChange, SyncConflict, SyncTableName } from './types'

const logger = loggerService.withContext('ConflictResolver')

/** Per-table conflict resolution policy */
type ConflictPolicy = 'lww' | 'merge' | 'restore-wins'

const TABLE_POLICIES: Record<SyncTableName, ConflictPolicy> = {
  topics: 'lww',
  message_blocks: 'lww',
  files: 'lww',
  settings: 'merge',
  knowledge_notes: 'lww',
  translate_history: 'lww',
  translate_languages: 'lww',
  quick_phrases: 'lww'
}

export class ConflictResolver {
  /**
   * Determine how to resolve a conflict between a local and remote change.
   * Returns the resolution strategy and optionally a merged value.
   */
  resolve(local: SyncChange, remote: SyncChange): SyncConflict {
    // Special case: deletedAt field in topics — restore wins
    if (local.table === 'topics' && this.isDeletedAtConflict(local, remote)) {
      return this.resolveDeletedAt(local, remote)
    }

    const policy = TABLE_POLICIES[local.table]

    switch (policy) {
      case 'merge':
        return this.resolveWithMerge(local, remote)
      case 'lww':
      default:
        return this.resolveLWW(local, remote)
    }
  }

  /**
   * Last-Writer-Wins: compare timestamps.
   * If timestamps are equal, compare deviceIds lexicographically
   * to ensure deterministic resolution.
   */
  private resolveLWW(local: SyncChange, remote: SyncChange): SyncConflict {
    const localWins =
      local.timestamp > remote.timestamp || (local.timestamp === remote.timestamp && local.deviceId > remote.deviceId)

    const resolution = localWins ? 'local' : 'remote'

    logger.debug(
      `LWW resolution for ${local.table}/${local.key}: ${resolution} ` +
        `(local=${local.timestamp}, remote=${remote.timestamp})`
    )

    return {
      localChange: local,
      remoteChange: remote,
      resolution
    }
  }

  /**
   * Field-level merge for settings: combine non-overlapping field changes.
   * For UPDATE vs UPDATE: merge the modification objects.
   * For CREATE vs CREATE or DELETE: fall back to LWW.
   */
  private resolveWithMerge(local: SyncChange, remote: SyncChange): SyncConflict {
    // Only merge if both are UPDATEs with modification objects
    if (local.op === 'UPDATE' && remote.op === 'UPDATE') {
      const localMods = (local.newValue ?? {}) as Record<string, unknown>
      const remoteMods = (remote.newValue ?? {}) as Record<string, unknown>

      // Check if they modify different fields
      const localKeys = Object.keys(localMods)
      const remoteKeys = Object.keys(remoteMods)
      const overlap = localKeys.filter((k) => remoteKeys.includes(k))

      if (overlap.length === 0) {
        // No overlapping fields — merge both
        const merged = { ...remoteMods, ...localMods }
        logger.debug(
          `Merge resolution for ${local.table}/${local.key}: ` +
            `${localKeys.length} local + ${remoteKeys.length} remote fields`
        )
        return {
          localChange: local,
          remoteChange: remote,
          resolution: 'merged',
          mergedValue: merged
        }
      }
    }

    // Fall back to LWW for non-mergeable cases
    return this.resolveLWW(local, remote)
  }

  /**
   * Special handling for topics.deletedAt:
   *
   * Three-way distinction with priority ordering:
   *   1. Restore  (deletedAt explicitly set to null)     — highest priority
   *   2. Delete   (deletedAt set to a timestamp string)  — medium priority
   *   3. Regular  (deletedAt not touched in mods)        — lowest priority
   *
   * Priority: restore > delete > regular update.
   * Same-priority conflicts fall back to LWW.
   */
  private resolveDeletedAt(local: SyncChange, remote: SyncChange): SyncConflict {
    const PRIORITY: Record<string, number> = { restore: 3, delete: 2, undefined: 1 }
    const localAction = this.getDeletedAtAction(local)
    const remoteAction = this.getDeletedAtAction(remote)
    const localPrio = PRIORITY[localAction ?? 'undefined']
    const remotePrio = PRIORITY[remoteAction ?? 'undefined']

    if (localPrio > remotePrio) {
      logger.debug(`DeletedAt priority for ${local.table}/${local.key}: local ${localAction} > remote ${remoteAction}`)
      return { localChange: local, remoteChange: remote, resolution: 'local' }
    }

    if (remotePrio > localPrio) {
      logger.debug(`DeletedAt priority for ${local.table}/${local.key}: remote ${remoteAction} > local ${localAction}`)
      return { localChange: local, remoteChange: remote, resolution: 'remote' }
    }

    // Same action priority — fall back to LWW
    return this.resolveLWW(local, remote)
  }

  /** Check if a conflict involves the deletedAt field */
  private isDeletedAtConflict(local: SyncChange, remote: SyncChange): boolean {
    if (local.op !== 'UPDATE' || remote.op !== 'UPDATE') return false
    return this.getDeletedAtAction(local) !== undefined || this.getDeletedAtAction(remote) !== undefined
  }

  /**
   * Classify a change's action on deletedAt:
   *  - 'delete'  — deletedAt set to a truthy string (soft delete)
   *  - 'restore' — deletedAt explicitly cleared (set to null / undefined)
   *  - undefined — deletedAt not touched in this change
   */
  private getDeletedAtAction(change: SyncChange): 'delete' | 'restore' | undefined {
    if (change.op !== 'UPDATE') return undefined
    const mods = change.newValue as Record<string, unknown>
    if (!('deletedAt' in mods)) return undefined
    if (mods.deletedAt == null) return 'restore' // null or undefined
    return 'delete' // truthy timestamp string
  }
}
