/**
 * Phase 0 — Cross-device sync layer types
 *
 * ⚠️ This is a foundational API. Types must remain stable until v2.0.0.
 */

/** All Dexie tables eligible for cross-device sync */
export type SyncTableName =
  | 'topics'
  | 'message_blocks'
  | 'files'
  | 'settings'
  | 'knowledge_notes'
  | 'translate_history'
  | 'translate_languages'
  | 'quick_phrases'

/** Sync change operation kind */
export type ChangeOp = 'CREATE' | 'UPDATE' | 'DELETE'

/**
 * A single atomic change captured by Dexie hooks.
 * This is the public/external representation.
 */
export interface SyncChange {
  id: string
  table: SyncTableName
  op: ChangeOp
  key: string
  newValue?: unknown
  oldValue?: unknown
  txId?: string
  deviceId: string
  timestamp: number
  synced: boolean
  vector: Record<string, number>
}

/** Sync metadata persisted alongside user data */
export interface SyncMeta {
  id: string
  deviceId: string
  lastSyncSeq: number
  lastSyncTimestamp: number
}

// ─── Transport types ────────────────────────────────────────────

export interface PushResult {
  success: boolean
  syncedIds: string[]
  conflicts: SyncConflict[]
  error?: string
}

export interface PullResult {
  changes: SyncChange[]
  newSeq: number
}

export interface SyncConflict {
  localChange: SyncChange
  remoteChange: SyncChange
  resolution: 'local' | 'remote' | 'merged'
  mergedValue?: unknown
}

/** Pluggable transport contract */
export interface SyncTransport {
  push(changes: SyncChange[]): Promise<PushResult>
  pull(since: number): Promise<PullResult>
  connect(): Promise<void>
  disconnect(): void
  onRemoteChange(callback: (changes: SyncChange[]) => void): void
}

// ─── Engine types ───────────────────────────────────────────────

export type SyncState = 'idle' | 'connecting' | 'syncing' | 'error' | 'disconnected'

export interface SyncEngineEvents {
  onStateChange: (state: SyncState) => void
  onConflict: (conflict: SyncConflict) => void
  onError: (error: Error) => void
  onSyncComplete: (direction: 'push' | 'pull', count: number) => void
}
