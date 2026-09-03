import type { SyncPullResponse, SyncPushRequest } from '@shared/sync'
import { SYNC_REQUEST_TIMEOUT_MS, validateSyncEndpointUrl, validateSyncOperationStrict } from '@shared/sync'

export function validateEndpointUrl(raw: string): string | null {
  return validateSyncEndpointUrl(raw)
}

/**
 * Strict canonical request/response cursor guard (LOCK-RT-002): only
 * canonical non-negative safe integers are accepted. Local to SyncClient so
 * no import cycle with SyncService arises; the rule mirrors
 * `parseStrictCursor` number branch exactly (typeof number +
 * Number.isSafeInteger + >= 0, never reinterpreted).
 */
function assertSafeCursor(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where} malformed: cursor must be non-negative safe integer`)
  }
  return value
}

export class SyncClient {
  async push(
    endpoint: string,
    token: string | undefined,
    req: SyncPushRequest,
    externalSignal?: AbortSignal
  ): Promise<{ cursor: number; acceptedIds: string[] }> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    const url = endpoint.replace(/\/$/, '') + '/sync/push'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    const onExternalAbort = (): void => {
      try {
        controller.abort()
      } catch {}
    }
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`push failed ${res.status}: ${text.slice(0, 500)}`)
      }
      const data = (await res.json()) as { cursor: number; acceptedIds: string[] }
      if (!data || typeof data !== 'object' || !Array.isArray((data as any).acceptedIds)) {
        throw new Error('push response malformed: acceptedIds must be array')
      }
      if (
        typeof (data as any).cursor !== 'number' ||
        !Number.isSafeInteger((data as any).cursor) ||
        (data as any).cursor < 0
      ) {
        throw new Error('push response malformed: cursor must be non-negative safe integer')
      }
      for (const id of (data as any).acceptedIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('push response malformed: acceptedIds must be non-empty strings')
        }
      }
      return data
    } catch (e) {
      if ((e as Error).name === 'AbortError' && externalSignal?.aborted) throw e
      const msg = e instanceof Error ? e.message : String(e)
      if ((e as Error).name === 'AbortError') throw new Error(`push timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      throw new Error(msg)
    } finally {
      clearTimeout(timeout)
      if (externalSignal) {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort)
        } catch {}
      }
    }
  }

  async pull(
    endpoint: string,
    token: string | undefined,
    cursor: number,
    deviceId: string,
    externalSignal?: AbortSignal
  ): Promise<SyncPullResponse> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    // Strict request cursor (LOCK-RT-002): never stringify a malformed or
    // unsafe cursor into the relay request; fail closed before any transport.
    assertSafeCursor(cursor, 'pull request')
    const url = new URL(endpoint.replace(/\/$/, '') + '/sync/pull')
    url.searchParams.set('cursor', String(cursor))
    url.searchParams.set('deviceId', deviceId)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    const onExternalAbort = (): void => {
      try {
        controller.abort()
      } catch {}
    }
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
    try {
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`pull failed ${res.status}: ${text.slice(0, 500)}`)
      }
      const data = (await res.json()) as SyncPullResponse & { operations: Array<Record<string, unknown>> }
      if (!data || typeof data !== 'object' || !Array.isArray(data.operations)) {
        throw new Error('pull response malformed: operations must be array')
      }
      if (typeof data.cursor !== 'number' || !Number.isSafeInteger(data.cursor) || data.cursor < 0) {
        throw new Error('pull response malformed: cursor must be non-negative safe integer')
      }
      // Strict pull framing: every operation requires a positive integer seq;
      // cursor/operation consistency is validated before any application.
      // Contiguous framing: each op seq must equal request cursor + position
      // (cursor+1, cursor+2, ...). A gap rejects before any application or
      // cursor advance so a missing operation can never be skipped as success.
      // A malformed frame surfaces as a durable sync failure upstream, never
      // silently applied or skipped. Throw here so SyncService records
      // lastError truthfully and does not advance the cursor or report success.
      let prevSeq = cursor
      for (let i = 0; i < data.operations.length; i++) {
        const op = data.operations[i]
        const rec = op as Record<string, unknown>
        const seq: unknown = rec['seq']
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
          throw new Error(`pull response malformed: invalid seq for ${String(rec['id'] ?? '')}`)
        }
        const expectedSeq = prevSeq + 1
        if (seq !== expectedSeq) {
          throw new Error(
            `pull response non-contiguous: expected seq ${String(expectedSeq)} at position ${String(i)} but got ${String(seq)} (request cursor ${String(cursor)})`
          )
        }
        prevSeq = seq
        const err = validateSyncOperationStrict(op)
        if (err) {
          throw new Error(`pull response malformed operation ${String(rec['id'] ?? '')}: ${err}`)
        }
      }
      if (data.operations.length > 0) {
        const lastSeq = (data.operations[data.operations.length - 1] as Record<string, unknown>)['seq'] as number
        if (data.cursor !== lastSeq) {
          throw new Error(
            `pull response malformed: cursor ${String(data.cursor)} must equal last seq ${String(lastSeq)}`
          )
        }
      } else if (data.cursor !== cursor) {
        throw new Error(
          `pull response malformed: empty-page cursor ${String(data.cursor)} must equal request cursor ${String(cursor)}`
        )
      }
      return data
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (externalSignal?.aborted) throw e
        throw new Error(`pull timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      }
      throw e
    } finally {
      clearTimeout(timeout)
      if (externalSignal) {
        try {
          externalSignal.removeEventListener('abort', onExternalAbort)
        } catch {}
      }
    }
  }
}

export const syncClient = new SyncClient()
