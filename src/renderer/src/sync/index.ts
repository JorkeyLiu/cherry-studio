/**
 * Phase 0 — Cross-device sync layer entry point
 *
 * Re-exports all public APIs for the sync subsystem.
 */

// Import used by the singleton factory below
import { SyncEngine } from './SyncEngine'
import { CouchTransport } from './transports/CouchTransport'
import { RestTransport } from './transports/RestTransport'
import type { SyncTransport } from './types'

// Types
export type {
  ChangeOp,
  PullResult,
  PushResult,
  SyncChange,
  SyncConflict,
  SyncEngineEvents,
  SyncMeta,
  SyncState,
  SyncTableName,
  SyncTransport
} from './types'

// Factories & classes
export { getChangeQueue, initChangeCollector, isSkipSyncCollection, setSkipSyncCollection } from './ChangeCollector'
export type { QueueStore } from './ChangeQueue'
export { ChangeQueue } from './ChangeQueue'
export { ConflictResolver } from './ConflictResolver'
export { SyncEngine }
export { CouchTransport } from './transports/CouchTransport'
export { RestTransport } from './transports/RestTransport'
export type { SyncTransport as SyncTransportInterface } from './transports/Transport'

// Sync metadata helpers
export {
  getDeviceId,
  getLastSyncSeq,
  getLastSyncTimestamp,
  peekDeviceId,
  resetSyncMeta,
  setLastSyncSeq,
  touchLastSyncTimestamp
} from './SyncMeta'

// ── Global SyncEngine singleton ──────────────────────────────────

let _globalEngine: SyncEngine | null = null

/**
 * Initialize or reinitialize the global SyncEngine singleton.
 * Stops any existing engine before creating a new one.
 * Returns `null` when transport is disabled or URL is empty.
 */
export async function initSyncEngine(config: {
  transport: string
  url: string
  username?: string
  password?: string
  apiKey?: string
}): Promise<SyncEngine | null> {
  // Destroy existing engine
  if (_globalEngine) {
    await _globalEngine.stop()
    _globalEngine = null
  }

  if (config.transport === 'disabled' || !config.url) {
    return null
  }

  let transport: SyncTransport
  if (config.transport === 'couchdb') {
    transport = new CouchTransport({
      url: config.url,
      auth: config.username ? { username: config.username, password: config.password ?? '' } : undefined
    })
  } else {
    transport = new RestTransport({
      baseUrl: config.url,
      apiKey: config.apiKey
    })
  }

  _globalEngine = new SyncEngine(transport)
  return _globalEngine
}

/** Access the currently running SyncEngine singleton, if any. */
export function getGlobalSyncEngine(): SyncEngine | null {
  return _globalEngine
}

/** Stop and destroy the global SyncEngine singleton. */
export async function destroyGlobalSyncEngine(): Promise<void> {
  if (_globalEngine) {
    await _globalEngine.stop()
    _globalEngine = null
  }
}
