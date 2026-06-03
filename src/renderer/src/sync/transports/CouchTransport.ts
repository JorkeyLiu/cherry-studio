/**
 * Phase 3 — CouchDB-compatible transport
 *
 * Implements the SyncTransport interface against a CouchDB / Cloudant
 * database.  Uses the _bulk_docs endpoint for push and _changes feed
 * (longpoll) for pull and real‑time remote change detection.
 *
 * No external dependencies — uses the browser fetch API.
 *
 * === Conflict handling ===
 * When _bulk_docs returns a 409 conflict, the transport:
 *   1. Fetches the current remote document
 *   2. Creates a SyncChange from the remote doc
 *   3. Uses ConflictResolver to determine the winner
 *   4. If local/merged wins: re-pushes the winning version with the
 *      correct _rev and reports the conflict
 *   5. If remote wins: reports the conflict without including the
 *      change in syncedIds
 */

import { loggerService } from '@logger'

import { ConflictResolver } from '../ConflictResolver'
import type { PullResult, PushResult, SyncChange, SyncConflict } from '../types'
import type { SyncTransport } from './Transport'

const logger = loggerService.withContext('CouchTransport')

interface CouchOptions {
  /** e.g. 'http://localhost:5984/cherry-studio' */
  url: string
  auth?: { username: string; password: string }
}

export class CouchTransport implements SyncTransport {
  private url: string
  private auth?: { username: string; password: string }
  private remoteChangeCallback?: (changes: SyncChange[]) => void
  private pollController?: AbortController
  private polling = false

  /**
   * Cache of CouchDB document revisions keyed by `${table}:${key}`.
   * Updated after every successful _bulk_docs write.
   */
  private revCache = new Map<string, string>()

  /**
   * Stateless conflict resolver.  Uses LWW or merge strategy
   * depending on the table policy (see ConflictResolver).
   */
  private conflictResolver = new ConflictResolver()

  constructor(options: CouchOptions) {
    this.url = options.url.replace(/\/$/, '') // strip trailing slash
    this.auth = options.auth
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (this.auth) {
      h['Authorization'] = 'Basic ' + btoa(`${this.auth.username}:${this.auth.password}`)
    }
    return h
  }

  async connect(): Promise<void> {
    // Verify CouchDB is reachable
    try {
      const resp = await fetch(this.url, { headers: this.headers })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      logger.info(`Connected to CouchDB at ${this.url}`)
    } catch (err) {
      logger.error('Failed to connect to CouchDB', err as Error)
      throw err
    }
  }

  disconnect(): void {
    this.polling = false
    this.pollController?.abort()
    logger.info('Disconnected from CouchDB')
  }

  async push(changes: SyncChange[]): Promise<PushResult> {
    // Build CouchDB documents with stable _id (no timestamp suffix)
    const docs = changes.map((c) => {
      const docId = `${c.table}:${c.key}`
      const rev = this.revCache.get(docId)
      return {
        _id: docId,
        ...(rev ? { _rev: rev } : {}),
        ...c
      }
    })

    try {
      const resp = await fetch(`${this.url}/_bulk_docs`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ docs })
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const result = await resp.json()

      const syncedIds: string[] = []
      const conflicts: SyncConflict[] = []

      // ── Process each doc result (positional correspondence) ──
      for (let i = 0; i < result.length; i++) {
        const r = result[i] as { ok?: boolean; id: string; rev?: string; error?: string; reason?: string }
        const change = changes[i]
        const docId = `${change.table}:${change.key}`

        if (r.ok) {
          // Successfully written
          syncedIds.push(change.id)
          this.revCache.set(docId, r.rev!)
          continue
        }

        if (r.error === 'conflict') {
          // ── Fetch remote version to resolve conflict ──
          const remoteDoc = await this.fetchRemoteDoc(docId)
          if (!remoteDoc) {
            // Cannot resolve — skip this change
            logger.warn(`Cannot resolve conflict for ${docId}: failed to fetch remote doc`)
            continue
          }

          const remoteChange = this.docToSyncChange(remoteDoc, docId)

          // Resolve using the conflict resolver
          const resolution = this.conflictResolver.resolve(change, remoteChange)

          if (resolution.resolution === 'local' || resolution.resolution === 'merged') {
            // Local wins — re-push with remote's _rev
            const repushDoc = {
              _id: docId,
              _rev: remoteDoc._rev,
              table: change.table,
              key: change.key,
              op: change.op,
              newValue: resolution.resolution === 'merged' ? resolution.mergedValue : change.newValue,
              oldValue: change.oldValue,
              id: change.id,
              deviceId: change.deviceId,
              timestamp: Date.now(),
              synced: change.synced,
              vector: change.vector,
              txId: change.txId
            }

            const repushOk = await this.repushDoc(repushDoc)
            if (repushOk) {
              syncedIds.push(change.id)
            }
          }

          // Report the conflict (resolution already determined)
          conflicts.push(resolution)
        }
      }

      return { success: true, syncedIds, conflicts }
    } catch (err) {
      logger.error('Push failed', err as Error)
      return { success: false, syncedIds: [], conflicts: [], error: (err as Error).message }
    }
  }

  /**
   * Fetch a single document from CouchDB.  Returns `null` if the
   * document doesn't exist or on network error.
   */
  private async fetchRemoteDoc(docId: string): Promise<any | null> {
    try {
      const resp = await fetch(`${this.url}/${encodeURIComponent(docId)}`, {
        headers: this.headers
      })
      if (!resp.ok) {
        if (resp.status === 404) return null
        throw new Error(`HTTP ${resp.status}`)
      }
      return await resp.json()
    } catch (err) {
      logger.warn(`Failed to fetch remote doc ${docId}`, err as Error)
      return null
    }
  }

  /**
   * Re-push a single document after a conflict where the local version
   * won.  Uses a PUT request with the correct _rev.
   */
  private async repushDoc(doc: any): Promise<boolean> {
    try {
      const resp = await fetch(`${this.url}/${encodeURIComponent(doc._id)}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify(doc)
      })
      if (!resp.ok) {
        logger.warn(`Re-push failed for ${doc._id}: HTTP ${resp.status}`)
        return false
      }
      const result = await resp.json()
      if (result.ok) {
        this.revCache.set(doc._id, result.rev)
        return true
      }
      return false
    } catch (err) {
      logger.warn(`Re-push failed for ${doc._id}`, err as Error)
      return false
    }
  }

  /**
   * Convert a raw CouchDB document into a SyncChange, parsing the
   * _id to extract table and key.
   */
  private docToSyncChange(doc: any, _docId?: string): SyncChange {
    const [table, ...keyParts] = (_docId ?? doc._id).split(':')
    const key = keyParts.join(':')
    return {
      id: doc.id ?? doc._id,
      table,
      op: doc.op ?? 'UPDATE',
      key: doc.key ?? key,
      newValue: doc.newValue,
      oldValue: doc.oldValue,
      txId: doc.txId,
      deviceId: doc.deviceId,
      timestamp: doc.timestamp ?? Date.now(),
      synced: true,
      vector: doc.vector ?? {}
    }
  }

  async pull(since: number): Promise<PullResult> {
    try {
      const resp = await fetch(`${this.url}/_changes?since=${since}&include_docs=true&feed=longpoll&timeout=30000`, {
        headers: this.headers
      })

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()

      const changes: SyncChange[] = (data.results || [])
        .filter((r: any) => r.doc && !r.doc._deleted)
        .map((r: any) => this.docToSyncChange(r.doc, r.id))

      return { changes, newSeq: data.last_seq ?? since }
    } catch (err) {
      logger.error('Pull failed', err as Error)
      return { changes: [], newSeq: since }
    }
  }

  onRemoteChange(callback: (changes: SyncChange[]) => void): void {
    this.remoteChangeCallback = callback
    // Start long-polling for changes
    void this.startPolling()
  }

  private async startPolling(): Promise<void> {
    if (this.polling) return
    this.polling = true
    this.pollController = new AbortController()

    while (this.polling) {
      try {
        const resp = await fetch(`${this.url}/_changes?feed=longpoll&include_docs=true&timeout=60000`, {
          headers: this.headers,
          signal: this.pollController.signal
        })

        if (!resp.ok) break
        const data = await resp.json()

        if (this.remoteChangeCallback && data.results?.length) {
          const changes: SyncChange[] = data.results
            .filter((r: any) => r.doc && !r.doc._deleted)
            .map((r: any) => this.docToSyncChange(r.doc, r.id))
          this.remoteChangeCallback(changes)
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') break
        logger.warn('Poll error, retrying in 5s', err as Error)
        await new Promise((r) => setTimeout(r, 5000))
      }
    }
  }
}
