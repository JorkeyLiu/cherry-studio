/**
 * Main-only pure codecs for sync metadata stored in `sync_state`.
 *
 * Single source of truth for the tombstone value format and the channel-key
 * validity rule. `SyncService` (writer/reader) and `syncBaseline` (read-only
 * observer) both delegate here so the strict parsing semantics cannot drift.
 *
 * No DB access, no side effects, no timestamps, no randomness.
 */

import { SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH } from '@shared/sync'

export interface ParsedSyncTombstone {
  timestamp: number
  operationId: string | null
}

/**
 * Canonical sync operation-ID shape (strict contract shared by the wire
 * validator, tombstone persistence, and baseline clock observation):
 * non-empty string, no colon, at most 256 characters. Returns the validated
 * ID; throws fail-closed otherwise. Callers map the error into their own
 * boundary (SyncTombstoneError / SyncBaselineError) without changing it.
 */
export function parseSyncOperationIdShape(operationId: unknown): string {
  if (
    typeof operationId !== 'string' ||
    operationId.length === 0 ||
    operationId.includes(':') ||
    operationId.length > SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH
  ) {
    throw new Error(`malformed tombstone operationId ${JSON.stringify(String(operationId)).slice(0, 80)}`)
  }
  return operationId
}

/**
 * Canonical tombstone value format: `timestamp` (legacy timestamp-only form)
 * or `timestamp:operationId` (current form, exactly one colon).
 */
export function formatSyncTombstoneValue(timestamp: number, operationId: string | null): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`malformed tombstone timestamp ${String(timestamp).slice(0, 40)}`)
  }
  if (operationId !== null) parseSyncOperationIdShape(operationId)
  if (operationId === null) return String(timestamp)
  return `${String(timestamp)}:${operationId}`
}

/**
 * Strict tombstone parser. Absent input (null/undefined) is the only null
 * return. Any present-but-malformed value throws fail-closed so it is never
 * treated as absence.
 */
export function parseSyncTombstoneValue(value: string | null | undefined): ParsedSyncTombstone | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    throw new Error(`malformed tombstone value ${JSON.stringify(String(value)).slice(0, 80)}`)
  }
  const idx = value.indexOf(':')
  if (idx < 0) {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
    }
    const ts = Number(value)
    if (!Number.isSafeInteger(ts)) {
      throw new Error(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
    }
    return { timestamp: ts, operationId: null }
  }
  const tsPart = value.slice(0, idx)
  const opPart = value.slice(idx + 1)
  if (!/^(0|[1-9][0-9]*)$/.test(tsPart) || opPart.length === 0 || opPart.includes(':')) {
    throw new Error(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
  }
  const ts = Number(tsPart)
  if (!Number.isSafeInteger(ts)) {
    throw new Error(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
  }
  if (opPart.length > SYNC_TOMBSTONE_OPERATION_ID_MAX_LENGTH) {
    throw new Error(`malformed tombstone value ${JSON.stringify(value).slice(0, 80)}`)
  }
  return { timestamp: ts, operationId: opPart }
}

/**
 * Strict channel-key parser. Any absent-or-present distinction belongs to the
 * caller (missing row means unbound); every value passed here must be a
 * non-empty string of at most 256 characters or it throws fail-closed.
 */
export function parseSyncChannelKeyValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error('malformed persisted channel key')
  }
  return value
}
