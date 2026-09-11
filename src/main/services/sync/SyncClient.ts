import type {
  SyncEnvelope,
  SyncIncomingPairRequest,
  SyncOutgoingPairRequest,
  SyncPullResponse,
  SyncPushRequest
} from '@shared/sync'
import {
  isValidSyncDeviceAuth,
  isValidSyncDeviceId,
  normalizePairingCode,
  parseEnvelopeJson,
  SYNC_DEVICE_CODE_HEADER,
  SYNC_DEVICE_SECRET_HEADER,
  SYNC_REQUEST_TIMEOUT_MS,
  validatePairingCode,
  validatePairingRequestId,
  validateSyncDeviceName,
  validateSyncEndpointUrl,
  validateSyncOperationStrict
} from '@shared/sync'

import { relayHttpError } from './relayError'

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

export interface SyncPairStateResponse {
  deviceCode: string
  paired: boolean
  channelId: string | null
  outgoing: SyncOutgoingPairRequest | null
  incoming: SyncIncomingPairRequest[]
}

export type BaselineFetchResult = { found: false } | { found: true; envelope: SyncEnvelope; rawText: string }

/**
 * Strict 404 empty-state gate (SYNC-CC-023): only the exact relay
 * `{error:'baseline-not-found'}` body (exact single `error` key per the
 * existing relay `{error}` contract style) is the legitimate empty state.
 * HTML, empty, other error codes, or extra keys fail closed via the standard
 * relayFailure path and never masquerade as no-baseline.
 */
function isBaselineNotFoundBody(text: string): boolean {
  if (!text || text.trim().length === 0) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  if (Object.keys(obj).length !== 1 || !Object.prototype.hasOwnProperty.call(obj, 'error')) return false
  return obj['error'] === 'baseline-not-found'
}

export class SyncClient {
  /**
   * Device-identity headers (SYNC-CC-007/014): every device-authenticated
   * call identifies with the public device code and proves it with the
   * durable secret credential. The code alone never authorizes; the secret
   * is never logged; validation failures throw before transport.
   */
  private deviceHeaders(deviceCode: string, deviceSecret: string): Record<string, string> {
    const codeErr = validatePairingCode(deviceCode)
    if (codeErr) throw new Error(`device code invalid: ${codeErr}`)
    if (!isValidSyncDeviceAuth(deviceSecret)) throw new Error('device auth invalid')
    return {
      [SYNC_DEVICE_CODE_HEADER]: normalizePairingCode(deviceCode),
      [SYNC_DEVICE_SECRET_HEADER]: deviceSecret
    }
  }

  private parseIssuedDeviceSecret(data: unknown): string | undefined {
    const secret = (data as { deviceSecret?: unknown })?.deviceSecret
    if (secret === undefined) return undefined
    if (!isValidSyncDeviceAuth(secret)) throw new Error('device secret response malformed')
    return secret
  }

  private parseOptionalChannelId(data: unknown): string | undefined {
    const channelId = (data as { channelId?: unknown })?.channelId
    if (channelId === undefined || channelId === null) return undefined
    if (typeof channelId !== 'string' || channelId.length === 0 || channelId.length > 256) {
      throw new Error('channel id response malformed')
    }
    return channelId
  }

  /**
   * Relay error bodies flow through the centralized sanitizer
   * (`relayError.ts`): JSON secret keys are recursively stripped
   * (arrays/nesting included) and plain text never echoes raw content —
   * only a strictly allowlisted short code or the fixed safe summary plus
   * HTTP status survives. The thrown error `cause` carries only the numeric
   * status, never the raw body.
   */
  private relayFailure(operation: string, status: number, body: unknown): Error {
    return relayHttpError(operation, status, body)
  }

  async push(
    endpoint: string,
    token: string | undefined,
    req: SyncPushRequest,
    externalSignal?: AbortSignal,
    deviceCode?: string,
    deviceSecret?: string
  ): Promise<{ cursor: number; acceptedIds: string[]; channelId?: string }> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    if (deviceCode === undefined || deviceSecret === undefined) {
      throw new Error('push failed: service not connected (registration required)')
    }
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...this.deviceHeaders(deviceCode, deviceSecret)
      }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw this.relayFailure('push', res.status, text)
      }
      const data = (await res.json()) as { cursor: number; acceptedIds: string[]; channelId?: unknown }
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
      const channelId = this.parseOptionalChannelId(data)
      return channelId !== undefined
        ? { ...(data as { cursor: number; acceptedIds: string[] }), channelId }
        : (data as { cursor: number; acceptedIds: string[] })
    } catch (e) {
      if ((e as Error).name === 'AbortError' && externalSignal?.aborted) throw e
      if ((e as Error).name === 'AbortError') throw new Error(`push timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
      if (e instanceof Error) throw e
      throw new Error(String(e))
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
    externalSignal?: AbortSignal,
    deviceCode?: string,
    deviceSecret?: string
  ): Promise<SyncPullResponse> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    // Strict request cursor (LOCK-RT-002): never stringify a malformed or
    // unsafe cursor into the relay request; fail closed before any transport.
    assertSafeCursor(cursor, 'pull request')
    if (!isValidSyncDeviceId(deviceId)) throw new Error('device id invalid')
    if (deviceCode === undefined || deviceSecret === undefined) {
      throw new Error('pull failed: service not connected (registration required)')
    }
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
      const headers: Record<string, string> = { ...this.deviceHeaders(deviceCode, deviceSecret) }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw this.relayFailure('pull', res.status, text)
      }
      const data = (await res.json()) as SyncPullResponse & { operations: Array<Record<string, unknown>> }
      if (!data || typeof data !== 'object' || !Array.isArray(data.operations)) {
        throw new Error('pull response malformed: operations must be array')
      }
      if (typeof data.cursor !== 'number' || !Number.isSafeInteger(data.cursor) || data.cursor < 0) {
        throw new Error('pull response malformed: cursor must be non-negative safe integer')
      }
      // Channel identity is internal (never user-visible) but must be
      // well-formed when present so cursor scoping cannot be corrupted.
      const channelId = this.parseOptionalChannelId(data)
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
        const seqNum = seq
        const expectedSeq = prevSeq + 1
        if (seqNum !== expectedSeq) {
          throw new Error(
            `pull response non-contiguous: expected seq ${String(expectedSeq)} at position ${String(i)} but got ${String(seqNum)} (request cursor ${String(cursor)})`
          )
        }
        prevSeq = seqNum
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
      return channelId !== undefined ? { ...data, channelId } : data
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

  /**
   * Receiver bootstrap fetch (SYNC-CC-022/023, SYNC-DATA-046/047): GET the
   * caller's channel current-effective `sync-baseline-wire-v1` envelope.
   * Auth follows the existing device-header plane; Bearer token added when
   * present. 200 strictly parses the raw body via the shared
   * `parseEnvelopeJson` (exact keys/duplicate-key rejection, no reinterpret);
   * digest recompute stays in the wire apply adapter. 404 with the strict
   * `{error:'baseline-not-found'}` body is the explicit no-baseline typed
   * result (empty channel, not a routing error); any other 404 body (HTML,
   * empty, other error, extra keys) throws via the existing safe mapping.
   * Other non-2xx retain the relay `{error}` via the existing safe mapping.
   */
  async fetchBaseline(
    endpoint: string,
    token: string | undefined,
    deviceCode: string,
    deviceSecret: string,
    externalSignal?: AbortSignal
  ): Promise<BaselineFetchResult> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    if (!deviceCode || !deviceSecret) {
      throw new Error('baseline fetch failed: service not connected (registration required)')
    }
    const url = endpoint.replace(/\/$/, '') + '/sync/baseline'
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
      const headers: Record<string, string> = { ...this.deviceHeaders(deviceCode, deviceSecret) }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
      if (res.status === 404) {
        const text = await res.text().catch(() => '')
        if (isBaselineNotFoundBody(text)) return { found: false }
        throw this.relayFailure('baseline fetch', res.status, text)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw this.relayFailure('baseline fetch', res.status, text)
      }
      const rawText = await res.text()
      let envelope: SyncEnvelope
      try {
        envelope = parseEnvelopeJson(rawText)
      } catch (e) {
        throw new Error(`baseline fetch response malformed: ${e instanceof Error ? e.message : String(e)}`)
      }
      return { found: true, envelope, rawText }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (externalSignal?.aborted) throw e
        throw new Error(`baseline fetch timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
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

  private async requestJson(
    endpoint: string,
    token: string | undefined,
    path: string,
    init: {
      method: string
      body?: unknown
      query?: Record<string, string>
      deviceCode?: string
      deviceSecret?: string
    },
    externalSignal?: AbortSignal
  ): Promise<any> {
    const validation = validateEndpointUrl(endpoint)
    if (validation) throw new Error(validation)
    const base = endpoint.replace(/\/$/, '')
    const url = new URL(base + path)
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v)
    }
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
      if (init.deviceCode !== undefined || init.deviceSecret !== undefined) {
        if (init.deviceCode === undefined || init.deviceSecret === undefined) {
          throw new Error('device code and secret are both required')
        }
        Object.assign(headers, this.deviceHeaders(init.deviceCode, init.deviceSecret))
      }
      if (init.body !== undefined) headers['Content-Type'] = 'application/json'
      const res = await fetch(url.toString(), {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw this.relayFailure('sync request', res.status, text)
      }
      return await res.json()
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (externalSignal?.aborted) throw e
        throw new Error(`sync timeout after ${SYNC_REQUEST_TIMEOUT_MS}ms`)
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

  /**
   * Explicit registration (SYNC-CC-004). First call (no code/secret)
   * registers the device and returns the stable public device code plus the
   * durable secret (plaintext exactly once — the caller must persist it).
   * Later calls with the stored code+secret re-attach without rotation;
   * unknown credentials fail closed and are never silently re-registered.
   */
  async register(
    endpoint: string,
    token: string | undefined,
    args: { deviceCode?: string; deviceSecret?: string; deviceId?: string }
  ): Promise<{ deviceCode: string; deviceSecret?: string }> {
    const endpointErr = validateEndpointUrl(endpoint)
    if (endpointErr) throw new Error(endpointErr)
    if (args.deviceId !== undefined && !isValidSyncDeviceId(args.deviceId)) throw new Error('device id invalid')
    if ((args.deviceCode === undefined) !== (args.deviceSecret === undefined)) {
      throw new Error('device code and secret are both required')
    }
    if (args.deviceCode !== undefined && validatePairingCode(args.deviceCode)) {
      throw new Error('device code invalid')
    }
    if (args.deviceSecret !== undefined && !isValidSyncDeviceAuth(args.deviceSecret)) {
      throw new Error('device auth invalid')
    }
    const body: Record<string, string> = {}
    if (args.deviceCode !== undefined) body.deviceCode = normalizePairingCode(args.deviceCode)
    if (args.deviceSecret !== undefined) body.deviceSecret = args.deviceSecret
    if (args.deviceId !== undefined) body.deviceId = args.deviceId
    const data = await this.requestJson(endpoint, token, '/sync/register', { method: 'POST', body })
    if (!data || typeof data.deviceCode !== 'string' || validatePairingCode(data.deviceCode)) {
      throw new Error('register response malformed: deviceCode must be a device code')
    }
    const issued = this.parseIssuedDeviceSecret(data)
    const deviceCode = normalizePairingCode(data.deviceCode as string)
    if (args.deviceCode === undefined && issued === undefined) {
      throw new Error('register response malformed: missing device secret')
    }
    return issued !== undefined ? { deviceCode, deviceSecret: issued } : { deviceCode }
  }

  /** Pairing/channel state for the calling device (SYNC-CC-003/006). */
  async getPairState(
    endpoint: string,
    token: string | undefined,
    deviceCode: string,
    deviceSecret: string
  ): Promise<SyncPairStateResponse> {
    const data = await this.requestJson(endpoint, token, '/sync/state', {
      method: 'GET',
      deviceCode,
      deviceSecret
    })
    if (!data || typeof data !== 'object') throw new Error('pair state response malformed')
    if (typeof data.deviceCode !== 'string' || validatePairingCode(data.deviceCode)) {
      throw new Error('pair state response malformed: deviceCode')
    }
    if (typeof data.paired !== 'boolean') throw new Error('pair state response malformed: paired')
    if (data.channelId !== null && data.channelId !== undefined && typeof data.channelId !== 'string') {
      throw new Error('pair state response malformed: channelId')
    }
    const outgoing = (data as { outgoing?: unknown }).outgoing
    if (outgoing !== null && outgoing !== undefined) {
      const o = outgoing as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.targetCode !== 'string' || validatePairingCode(o.targetCode)) {
        throw new Error('pair state response malformed: outgoing')
      }
    }
    const incoming = (data as { incoming?: unknown }).incoming
    if (!Array.isArray(incoming)) throw new Error('pair state response malformed: incoming')
    for (const item of incoming) {
      const r = item as Record<string, unknown>
      if (typeof r.id !== 'string' || typeof r.requesterCode !== 'string' || validatePairingCode(r.requesterCode)) {
        throw new Error('pair state response malformed: incoming')
      }
    }
    return {
      deviceCode: normalizePairingCode(data.deviceCode as string),
      paired: data.paired as boolean,
      channelId: (data.channelId as string | null | undefined) ?? null,
      outgoing: (outgoing as SyncOutgoingPairRequest | null | undefined) ?? null,
      incoming: incoming as SyncIncomingPairRequest[]
    }
  }

  private assertPairingTransport(endpoint: string, deviceName?: string): void {
    const endpointErr = validateEndpointUrl(endpoint)
    if (endpointErr) throw new Error(endpointErr)
    const nameErr = validateSyncDeviceName(deviceName ?? undefined)
    if (nameErr) throw new Error(nameErr)
  }

  /**
   * Request pairing with the device holding the target device code
   * (SYNC-CC-007/008). At most one outgoing pending request per device;
   * retries to the same target are idempotent, a new target replaces the
   * old pending request.
   */
  async requestPairing(
    endpoint: string,
    token: string | undefined,
    args: { targetCode: string },
    deviceCode: string,
    deviceSecret: string
  ): Promise<{ requestId: string; status: string }> {
    this.assertPairingTransport(endpoint)
    const codeErr = validatePairingCode(args.targetCode)
    if (codeErr) throw new Error(codeErr)
    const data = await this.requestJson(endpoint, token, '/sync/pair/request', {
      method: 'POST',
      body: { targetCode: normalizePairingCode(args.targetCode) },
      deviceCode,
      deviceSecret
    })
    if (!data || typeof data.requestId !== 'string') {
      throw new Error('pairing request response malformed')
    }
    return { requestId: data.requestId as string, status: String(data.status ?? 'pending') }
  }

  async cancelPairing(
    endpoint: string,
    token: string | undefined,
    args: { requestId?: string },
    deviceCode: string,
    deviceSecret: string
  ): Promise<{ requestId: string }> {
    this.assertPairingTransport(endpoint)
    if (args.requestId !== undefined) {
      const idErr = validatePairingRequestId(args.requestId)
      if (idErr) throw new Error(idErr)
    }
    const data = await this.requestJson(endpoint, token, '/sync/pair/cancel', {
      method: 'POST',
      body: args.requestId !== undefined ? { requestId: args.requestId } : {},
      deviceCode,
      deviceSecret
    })
    if (!data || data.ok !== true || typeof data.requestId !== 'string') {
      throw new Error('cancel response malformed')
    }
    return { requestId: data.requestId as string }
  }

  async acceptPairing(
    endpoint: string,
    token: string | undefined,
    args: { requestId: string },
    deviceCode: string,
    deviceSecret: string
  ): Promise<{ channelId: string }> {
    const idErr = validatePairingRequestId(args.requestId)
    if (idErr) throw new Error(idErr)
    const data = await this.requestJson(endpoint, token, '/sync/pair/accept', {
      method: 'POST',
      body: args,
      deviceCode,
      deviceSecret
    })
    if (!data || data.ok !== true || typeof data.channelId !== 'string') {
      throw new Error('accept response malformed')
    }
    return { channelId: data.channelId as string }
  }

  async rejectPairing(
    endpoint: string,
    token: string | undefined,
    args: { requestId: string },
    deviceCode: string,
    deviceSecret: string
  ): Promise<void> {
    const idErr = validatePairingRequestId(args.requestId)
    if (idErr) throw new Error(idErr)
    const data = await this.requestJson(endpoint, token, '/sync/pair/reject', {
      method: 'POST',
      body: args,
      deviceCode,
      deviceSecret
    })
    if (!data || data.ok !== true) throw new Error('reject response malformed')
  }

  /**
   * Remove only this device's channel membership (SYNC-CC-011). Requires a
   * connected relay. Service registration and local chats are preserved by
   * contract (client-side; the relay only drops membership).
   */
  async unpair(endpoint: string, token: string | undefined, deviceCode: string, deviceSecret: string): Promise<void> {
    const data = await this.requestJson(endpoint, token, '/sync/pair/unpair', {
      method: 'POST',
      body: {},
      deviceCode,
      deviceSecret
    })
    if (!data || data.ok !== true) throw new Error('unpair response malformed')
  }
}

export const syncClient = new SyncClient()
