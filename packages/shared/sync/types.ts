/**
 * Sync operation types — app-level operation log for chat sync MVP.
 * JSON-only, no Node/Electron imports.
 */

export type SyncEntityType = 'topic' | 'message' | 'message_block'

export type SyncOperationKind = 'upsert' | 'delete'

export interface SyncOperation {
  /** Globally unique operation ID (uuid v4). Tie-break for LWW. */
  id: string
  /** Entity type. */
  entityType: SyncEntityType
  /** Operation kind. */
  op: SyncOperationKind
  /** Target entity ID (topic id / message id / block id). */
  entityId: string
  /** Logical timestamp (ms since epoch). LWW primary key. */
  timestamp: number
  /** Creating device ID. */
  deviceId: string
  /** Allowlisted payload for upsert. Undefined for delete. */
  payload?: Record<string, unknown>
}

/** Relay persists operations with monotonic sequence number. */
export interface SyncRelayOperation extends SyncOperation {
  seq: number
}

export interface SyncPushRequest {
  deviceId: string
  operations: SyncOperation[]
}

export interface SyncPushResponse {
  acceptedIds: string[]
  cursor: number
}

export interface SyncPullResponse {
  operations: SyncRelayOperation[]
  cursor: number
}

export interface SyncConfig {
  endpoint: string
  token?: string
  enabled: boolean
}

export interface SyncStatus {
  enabled: boolean
  endpoint: string
  lastSyncAt: string | null
  lastError: string | null
  pendingCount: number
  cursor: number
  syncing: boolean
}

export const SYNC_MAX_OPERATIONS_PER_PUSH = 200
export const SYNC_MAX_OPERATIONS_PER_PULL = 200
export const SYNC_REQUEST_TIMEOUT_MS = 15000
export const SYNC_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024

export function isSyncOperation(value: unknown): value is SyncOperation {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.entityType === 'string' &&
    typeof v.op === 'string' &&
    typeof v.entityId === 'string' &&
    typeof v.timestamp === 'number' &&
    typeof v.deviceId === 'string'
  )
}
