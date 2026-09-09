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
  /**
   * Stable internal channel identity scoping this cursor (SYNC-CC-016).
   * Internal only: used for per-channel cursor scoping, never shown in UI.
   */
  channelId?: string
}

export interface SyncPullResponse {
  operations: SyncRelayOperation[]
  cursor: number
  /**
   * Stable internal channel identity scoping this cursor (SYNC-CC-016).
   * Internal only: used for per-channel cursor scoping, never shown in UI.
   */
  channelId?: string
}

export interface SyncConfig {
  endpoint: string
  token?: string
  enabled: boolean
}

/**
 * Relay service connection state (SYNC-CC-003/004/006), observed per client.
 * Separate from channel pairing state. Reports this client's own observed
 * relay attachment, never broadcast presence of other devices.
 */
export type SyncServiceState = 'unregistered' | 'connected' | 'disconnected'

export interface SyncServiceStatus {
  state: SyncServiceState
  /** This device's public device code when registered. Safe to display. */
  deviceCode: string | null
  /** True after an explicit user Disconnect (attachment stopped, registration kept). */
  explicitDisconnect: boolean
}

export interface SyncStatus {
  enabled: boolean
  endpoint: string
  lastSyncAt: string | null
  lastError: string | null
  lastCaptureError: string | null
  pendingCount: number
  cursor: number
  syncing: boolean
  /**
   * Unresolved same-field conflict records (bounded durable log).
   * Deterministic LWW winner applied; loser retained for future recovery.
   * Dedicated restore UI is deferred — count is honest pending-conflict state.
   */
  conflictCount: number
}

/**
 * Field-level patch semantics (LOCK-PERSONAL-005/010):
 * upsert payloads carry only intentional changed allowlisted fields plus
 * identity/immutable relation fields (`id` always; `topicId` for messages,
 * `messageId` for blocks). Absent keys mean no intent and must be preserved
 * on apply (never wiped). Present keys including explicit null are intent.
 * Creates carry the full allowlisted set; updates carry the changed subset
 * (never `sortOrder` — reorder is unsupported).
 */

/** Mutable allowlisted topic fields with per-field clocks (identity `id` excluded). */
export const SYNC_TOPIC_PATCH_FIELDS = [
  'name',
  'assistantId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'pinned',
  'prompt',
  'isNameManuallyEdited'
] as const

/** Mutable allowlisted message fields with per-field clocks (`topicId` is immutable identity). */
export const SYNC_MESSAGE_PATCH_FIELDS = [
  'role',
  'content',
  'status',
  'askId',
  'model',
  'modelId',
  'assistantId',
  'createdAt',
  'updatedAt'
] as const

/** Mutable allowlisted block fields with per-field clocks (`messageId` is immutable identity). */
export const SYNC_BLOCK_PATCH_FIELDS = ['type', 'content', 'status', 'createdAt', 'updatedAt'] as const

/** Fixed bound for the durable same-field conflict record log. */
export const SYNC_CONFLICT_LOG_MAX = 100

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
