/**
 * Phase 3 — Simple REST API transport
 *
 * Implements the SyncTransport interface for a custom sync server.
 * Uses HTTP fetch for push / pull and WebSocket for real‑time remote
 * change notifications.
 */

import { loggerService } from '@logger'

import type { PullResult, PushResult, SyncChange } from '../types'
import type { SyncTransport } from './Transport'

const logger = loggerService.withContext('RestTransport')

interface RestOptions {
  /** e.g. 'https://sync.example.com/api' */
  baseUrl: string
  apiKey?: string
}

export class RestTransport implements SyncTransport {
  private baseUrl: string
  private apiKey?: string
  private remoteChangeCallback?: (changes: SyncChange[]) => void
  private ws?: WebSocket
  private wsReconnectTimer?: ReturnType<typeof setTimeout>

  constructor(options: RestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  async connect(): Promise<void> {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, { headers: this.headers })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      logger.info(`Connected to sync server at ${this.baseUrl}`)
    } catch (err) {
      logger.error('Failed to connect to sync server', err as Error)
      throw err
    }
  }

  disconnect(): void {
    this.ws?.close()
    clearTimeout(this.wsReconnectTimer)
    logger.info('Disconnected from sync server')
  }

  async push(changes: SyncChange[]): Promise<PushResult> {
    try {
      const resp = await fetch(`${this.baseUrl}/sync/push`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ changes })
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return await resp.json()
    } catch (err) {
      logger.error('Push failed', err as Error)
      return { success: false, syncedIds: [], conflicts: [], error: (err as Error).message }
    }
  }

  async pull(since: number): Promise<PullResult> {
    try {
      const resp = await fetch(`${this.baseUrl}/sync/pull?since=${since}`, {
        headers: this.headers
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return await resp.json()
    } catch (err) {
      logger.error('Pull failed', err as Error)
      return { changes: [], newSeq: since }
    }
  }

  onRemoteChange(callback: (changes: SyncChange[]) => void): void {
    this.remoteChangeCallback = callback
    this.connectWebSocket()
  }

  private connectWebSocket(): void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/sync/ws'
    try {
      this.ws = new WebSocket(wsUrl)
      this.ws.onmessage = (event) => {
        try {
          const changes: SyncChange[] = JSON.parse(event.data)
          this.remoteChangeCallback?.(changes)
        } catch {
          /* ignore parse errors */
        }
      }
      this.ws.onclose = () => {
        // Reconnect after 5s
        this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 5000)
      }
      this.ws.onerror = () => {
        this.ws?.close()
      }
    } catch (err) {
      logger.warn('WebSocket connection failed', err as Error)
    }
  }
}
