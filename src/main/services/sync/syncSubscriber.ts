import { loggerService } from '@logger'
import {
  isValidSyncDeviceAuth,
  SYNC_DEVICE_CODE_HEADER,
  SYNC_DEVICE_SECRET_HEADER,
  validatePairingCode
} from '@shared/sync'

import { relayHttpError, sanitizeRelayErrorBody } from './relayError'

const logger = loggerService.withContext('SyncSubscriber')

export interface SyncSubscriberEvents {
  onNotify: (hintCursor: number) => void
  onDisconnect: (error?: Error) => void
}

/**
 * Parse one SSE buffer into complete `data:` cursor-hint events.
 * Returns emitted hint cursors plus the unconsumed tail. Heartbeat/comment
 * lines (`: ...`) and non-sync events are ignored. Payloads are never trusted:
 * only a non-negative integer `cursor` field is emitted; anything else is
 * dropped without error so a faulty relay can never drive cursor movement.
 */
export function parseSseCursorHints(buffer: string): { hints: number[]; rest: string } {
  const hints: number[] = []
  // Standards-compatible framing: normalize CRLF (and lone CR) to LF before
  // splitting so CRLF-delimited event streams parse identically to LF ones.
  // The returned tail is the normalized remainder; callers reuse it as the
  // next buffer (subsequent chunks are normalized idempotently on entry).
  const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // SSE events are delimited by a blank line. Keep the trailing partial block.
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    const lines = block.split('\n')
    let eventName = ''
    const dataLines: string[] = []
    for (const raw of lines) {
      const line = raw
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart())
      }
    }
    if (dataLines.length === 0) continue
    if (eventName !== '' && eventName !== 'sync') continue
    const raw = dataLines.join('\n')
    try {
      const parsed: unknown = JSON.parse(raw)
      const cursor = (parsed as { cursor?: unknown })?.cursor
      if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) {
        hints.push(cursor)
      }
    } catch {
      // Ignore malformed hint frames; strict pull remains the only reader.
    }
  }
  return { hints, rest }
}

/**
 * Main-owned notification-only SSE subscriber over fetch streaming so the
 * Authorization header is retained (no EventSource, no query token, no new
 * dependency). The stream carries only a non-authoritative cursor hint;
 * all data moves through the existing authenticated HTTP push/pull path.
 */
export interface SyncSubscriberDevice {
  deviceCode: string
  deviceSecret: string
}

export class SyncSubscriber {
  private abort: AbortController | null = null
  private stopped = true
  private running = false

  isActive(): boolean {
    return this.running
  }

  start(
    endpoint: string,
    token: string | undefined,
    events: SyncSubscriberEvents,
    device?: SyncSubscriberDevice
  ): void {
    this.stop()
    this.stopped = false
    const url = `${endpoint.replace(/\/$/, '')}/sync/subscribe?cursor=0`
    const controller = new AbortController()
    this.abort = controller
    this.running = true
    void this.connect(url, token, events, controller.signal, device)
  }

  stop(): void {
    this.stopped = true
    this.running = false
    const controller = this.abort
    this.abort = null
    if (controller) {
      try {
        controller.abort()
      } catch {}
    }
  }

  private async connect(
    url: string,
    token: string | undefined,
    events: SyncSubscriberEvents,
    signal: AbortSignal,
    device?: SyncSubscriberDevice
  ): Promise<void> {
    let notifiedDisconnect = false
    const disconnectOnce = (error?: Error): void => {
      if (notifiedDisconnect) return
      notifiedDisconnect = true
      this.running = false
      if (!this.stopped) {
        try {
          events.onDisconnect(error)
        } catch (e) {
          logger.warn(`[subscriber] onDisconnect handler failed: ${(e as Error).message}`)
        }
      }
    }
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      // Channel-scoped SSE (SYNC-CC-016): the subscription authenticates as
      // the registered device so the relay binds it to exactly one channel.
      // Validation failures throw before transport (fail closed).
      if (device !== undefined) {
        const codeErr = validatePairingCode(device.deviceCode)
        if (codeErr) throw new Error(`subscribe failed: device code invalid: ${codeErr}`)
        if (!isValidSyncDeviceAuth(device.deviceSecret)) throw new Error('subscribe failed: device auth invalid')
        headers[SYNC_DEVICE_CODE_HEADER] = device.deviceCode.trim().toUpperCase()
        headers[SYNC_DEVICE_SECRET_HEADER] = device.deviceSecret
      }
      const res = await fetch(url, { method: 'GET', headers, signal })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        // Centralized sanitizer: SSE non-2xx bodies never echo raw text
        // (plain text cannot reliably identify an arbitrary secret); only
        // the fixed safe summary or a strictly allowlisted code plus the
        // HTTP status survives, with no raw body on `cause`.
        throw relayHttpError('subscribe', res.status, text)
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        // Header values are untrusted relay input as well: only a strictly
        // sanitized fragment is ever recorded.
        const safeContentType = sanitizeRelayErrorBody(contentType, res.status)
        throw new Error(`subscribe failed: unexpected content-type ${safeContentType}`.slice(0, 300))
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal.aborted || this.stopped) {
          try {
            await reader.cancel()
          } catch {}
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseSseCursorHints(buffer)
        buffer = parsed.rest
        for (const hint of parsed.hints) {
          if (signal.aborted || this.stopped) break
          try {
            events.onNotify(hint)
          } catch (e) {
            logger.warn(`[subscriber] onNotify handler failed: ${(e as Error).message}`)
          }
        }
      }
      try {
        await reader.cancel().catch(() => {})
      } catch {}
      disconnectOnce()
    } catch (e) {
      if (signal.aborted || this.stopped) {
        this.running = false
        return
      }
      const err = e instanceof Error ? e : new Error(String(e))
      logger.warn(`[subscriber] disconnected: ${err.message.slice(0, 200)}`)
      disconnectOnce(err)
    }
  }
}

export const syncSubscriber = new SyncSubscriber()
