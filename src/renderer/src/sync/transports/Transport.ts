/**
 * Phase 0 — Transport interface
 *
 * Defines the contract every sync transport (CouchDB, REST, …) must satisfy.
 */

import type { PullResult, PushResult, SyncChange } from '../types'

export type { PullResult, PushResult, SyncChange } from '../types'

export interface SyncTransport {
  /** Push local changes to the remote endpoint. */
  push(changes: SyncChange[]): Promise<PushResult>

  /** Pull remote changes since the given sequence number. */
  pull(since: number): Promise<PullResult>

  /** Open the underlying connection / authenticate. */
  connect(): Promise<void>

  /** Tear down the connection. */
  disconnect(): void

  /** Register a callback invoked when the remote reports new changes. */
  onRemoteChange(callback: (changes: SyncChange[]) => void): void
}
